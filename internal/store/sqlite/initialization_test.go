package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"testing/synctest"
	"time"

	"auth-server/internal/auth"

	sqlitedriver "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

func initializationDatabasePath(t *testing.T, filename string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatalf("make database directory private: %v", err)
	}
	path := filepath.Join(dir, filename)
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatalf("prepare database file: %v", err)
	}
	return path
}

func lockRollbackDatabase(t *testing.T, path string) (*sql.DB, *sql.Tx) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open rollback database: %v", err)
	}
	var mode string
	if err := db.QueryRowContext(t.Context(), "PRAGMA journal_mode=DELETE").Scan(&mode); err != nil {
		db.Close()
		t.Fatalf("enable rollback journal: %v", err)
	}
	if mode != "delete" {
		db.Close()
		t.Fatalf("journal mode = %q, want delete", mode)
	}
	if _, err := db.ExecContext(t.Context(), "CREATE TABLE retry_lock (value INTEGER NOT NULL)"); err != nil {
		db.Close()
		t.Fatalf("create write lock fixture: %v", err)
	}
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		db.Close()
		t.Fatalf("begin rollback journal transaction: %v", err)
	}
	if _, err := tx.ExecContext(t.Context(), "INSERT INTO retry_lock VALUES (1)"); err != nil {
		tx.Rollback()
		db.Close()
		t.Fatalf("acquire rollback journal write lock: %v", err)
	}
	return db, tx
}

func requireSQLiteBusy(t *testing.T, err error) {
	t.Helper()
	var sqliteErr *sqlitedriver.Error
	if !errors.As(err, &sqliteErr) || sqliteErr.Code()&0xff != sqlite3.SQLITE_BUSY {
		t.Fatalf("got %v, want SQLITE_BUSY", err)
	}
}

func TestOpenRetriesInitialWALTransition(t *testing.T) {
	path := initializationDatabasePath(t, "retry.db")
	synctest.Test(t, func(t *testing.T) {
		db, tx := lockRollbackDatabase(t, path)
		defer db.Close()
		defer tx.Rollback()
		const releaseAfter = 100 * time.Millisecond
		releaseCtx, stopRelease := context.WithCancel(t.Context())
		defer stopRelease()
		go func() {
			select {
			case <-time.After(releaseAfter):
				if err := tx.Rollback(); err != nil {
					t.Errorf("release rollback journal write lock: %v", err)
				}
			case <-releaseCtx.Done():
			}
		}()
		started := time.Now()
		s, err := Open(t.Context(), path)
		if err != nil {
			t.Fatalf("Open() did not retry a temporary WAL transition conflict: %v", err)
		}
		defer s.Close()
		if elapsed := time.Since(started); elapsed < releaseAfter {
			t.Fatalf("Open() returned before write lock release: %s", elapsed)
		}
		createTestUser(t, s, testUser())
	})
}

func TestOpenInitialWALTransitionRetryBudget(t *testing.T) {
	path := initializationDatabasePath(t, "retry.db")
	synctest.Test(t, func(t *testing.T) {
		db, tx := lockRollbackDatabase(t, path)
		defer db.Close()
		defer tx.Rollback()
		started := time.Now()
		s, err := Open(t.Context(), path)
		if s != nil {
			s.Close()
			t.Fatal("Open() returned a store while the WAL transition remained locked")
		}
		requireSQLiteBusy(t, err)
		if errors.Is(err, context.DeadlineExceeded) || t.Context().Err() != nil {
			t.Fatalf("internal retry limit reported as caller context expiry: %v", err)
		}
		if elapsed := time.Since(started); elapsed != openRetryTimeout {
			t.Fatalf("retry duration = %s, want %s", elapsed, openRetryTimeout)
		}
	})
}

func TestOpenInitialWALTransitionCallerCancellation(t *testing.T) {
	tests := []struct {
		name string
		ctx  func(*testing.T) (context.Context, context.CancelFunc)
		want error
	}{
		{"cancel", func(t *testing.T) (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancel(t.Context())
			go func() {
				select {
				case <-time.After(35 * time.Millisecond):
					cancel()
				case <-ctx.Done():
				}
			}()
			return ctx, cancel
		}, context.Canceled},
		{"deadline", func(t *testing.T) (context.Context, context.CancelFunc) {
			return context.WithTimeout(t.Context(), 35*time.Millisecond)
		}, context.DeadlineExceeded},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := initializationDatabasePath(t, "retry.db")
			synctest.Test(t, func(t *testing.T) {
				db, tx := lockRollbackDatabase(t, path)
				defer db.Close()
				defer tx.Rollback()
				ctx, cancel := tt.ctx(t)
				defer cancel()
				started := time.Now()
				s, err := Open(ctx, path)
				if s != nil {
					s.Close()
					t.Fatal("Open() returned a store after caller cancellation")
				}
				if !errors.Is(err, tt.want) {
					t.Fatalf("got %v, want caller context error %v", err, tt.want)
				}
				requireSQLiteBusy(t, err)
				if elapsed := time.Since(started); elapsed != 35*time.Millisecond {
					t.Fatalf("cancellation duration = %s, want 35ms", elapsed)
				}
			})
		})
	}
}

func TestOpenDatabaseDoesNotRetryUnexpectedError(t *testing.T) {
	path := initializationDatabasePath(t, "invalid.db")
	if err := os.WriteFile(path, []byte("invalid SQLite data"), 0600); err != nil {
		t.Fatalf("write invalid database: %v", err)
	}
	u := url.URL{Scheme: "file", Path: path}
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	u.RawQuery = q.Encode()
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		db, err := openDatabase(t.Context(), u.String())
		if db != nil {
			db.Close()
			t.Fatal("openDatabase() returned a pool for invalid data")
		}
		var sqliteErr *sqlitedriver.Error
		if !errors.As(err, &sqliteErr) || sqliteErr.Code() != sqlite3.SQLITE_NOTADB {
			t.Fatalf("got %v, want SQLITE_NOTADB", err)
		}
		if elapsed := time.Since(started); elapsed != 0 {
			t.Fatalf("unexpected error was retried for %s", elapsed)
		}
	})
}

func TestOpenRetryDoesNotApplyToLaterPoolConnections(t *testing.T) {
	path := initializationDatabasePath(t, "later.db")
	synctest.Test(t, func(t *testing.T) {
		s, err := Open(t.Context(), path)
		if err != nil {
			t.Fatalf("Open(): %v", err)
		}
		defer s.Close()
		s.db.SetMaxIdleConns(0)
		db, tx := lockRollbackDatabase(t, path)
		defer db.Close()
		defer tx.Rollback()
		started := time.Now()
		_, err = s.FindCredentialByEmail(t.Context(), "absent@example.test")
		requireSQLiteBusy(t, err)
		if !errors.Is(err, auth.ErrBusy) {
			t.Fatalf("later connection failure was not mapped to ErrBusy: %v", err)
		}
		if elapsed := time.Since(started); elapsed != 0 {
			t.Fatalf("later pooled connection was retried for %s", elapsed)
		}
	})
}
