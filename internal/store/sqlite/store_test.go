package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"auth-server/internal/auth"

	sqlitedriver "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

var timestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)

func privateTestDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatalf("make test directory private: %v", err)
	}
	return dir
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	return openTestStore(t, filepath.Join(privateTestDir(t), "auth.db"))
}

func openTestStore(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("Open() failed: %v", err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Errorf("Close() failed: %v", err)
		}
	})
	return s
}

func testUser() auth.NewUser {
	return auth.NewUser{
		ID:              "a48c1eb0-6c1b-4780-993d-208ed5e1212a",
		Email:           "Person@Example.test",
		EmailNormalized: "ExactCase@Example.test",
		PasswordHash:    "$argon2id$v=19$p=2,t=3,m=65536$c2FsdA$aGFzaA",
	}
}

func createTestUser(t *testing.T, s *Store, u auth.NewUser) {
	t.Helper()
	if err := s.CreateUser(t.Context(), u); err != nil {
		t.Fatalf("CreateUser() failed: %v", err)
	}
}

func requireRowCount(t *testing.T, s *Store, query string, want int) {
	t.Helper()
	var got int
	if err := s.db.QueryRowContext(t.Context(), query).Scan(&got); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if got != want {
		t.Fatalf("row count = %d, want %d", got, want)
	}
}

func requireSafeError(t *testing.T, err error, inputs ...string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, input := range inputs {
		if input != "" && strings.Contains(err.Error(), input) {
			t.Fatal("error contains a supplied input")
		}
	}
}

func requireTimestampBetween(t *testing.T, value string, before, after time.Time) {
	t.Helper()
	if !timestampPattern.MatchString(value) {
		t.Fatalf("timestamp %q does not match the schema format", value)
	}
	stamp, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatalf("parse timestamp %q: %v", value, err)
	}
	if stamp.Before(before) || stamp.After(after) {
		t.Fatalf("timestamp %q is outside [%s, %s]", value, before.Format(time.RFC3339Nano), after.Format(time.RFC3339Nano))
	}
}

// 1 つの接続で書き込みトランザクションを開いたままにし、もう 1 つの接続を指定の busy_timeout で
// プールへ戻す。プールの上限が 2 なので、次のストアの呼び出しはその接続でロックを待つ。
func holdWriteLock(t *testing.T, s *Store, busyTimeoutMillis int) {
	t.Helper()
	s.db.SetMaxOpenConns(2)
	holder, err := s.db.Conn(t.Context())
	if err != nil {
		t.Fatalf("acquire lock holder connection: %v", err)
	}
	t.Cleanup(func() { holder.Close() })
	waiter, err := s.db.Conn(t.Context())
	if err != nil {
		t.Fatalf("acquire waiting connection: %v", err)
	}
	if _, err := waiter.ExecContext(t.Context(), fmt.Sprintf("PRAGMA busy_timeout = %d", busyTimeoutMillis)); err != nil {
		t.Fatalf("set busy timeout on waiting connection: %v", err)
	}
	if err := waiter.Close(); err != nil {
		t.Fatalf("return waiting connection to the pool: %v", err)
	}
	tx, err := holder.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatalf("begin lock holder transaction: %v", err)
	}
	t.Cleanup(func() { tx.Rollback() })
}

func TestOpenInitializesAndReopensDatabase(t *testing.T) {
	path := filepath.Join(privateTestDir(t), "auth.db")
	s := openTestStore(t, path)
	requireRowCount(t, s, "SELECT count(*) FROM users", 0)
	requireRowCount(t, s, "SELECT count(*) FROM password_credentials", 0)
	u := testUser()
	createTestUser(t, s, u)
	if err := s.Close(); err != nil {
		t.Fatalf("Close() before reopening: %v", err)
	}

	reopened := openTestStore(t, path)
	c, err := reopened.FindCredentialByEmail(t.Context(), u.EmailNormalized)
	if err != nil {
		t.Fatalf("find persisted credential: %v", err)
	}
	if c.UserID != u.ID || c.PasswordHash != u.PasswordHash {
		t.Fatal("credential changed after reopening")
	}
	requireRowCount(t, reopened, "SELECT count(*) FROM users", 1)
	requireRowCount(t, reopened, "SELECT count(*) FROM password_credentials", 1)
	u.ID = "another-user"
	u.EmailNormalized = "another@example.test"
	createTestUser(t, reopened, u)
}

func TestCreateAndFindPreserveInput(t *testing.T) {
	s := newTestStore(t)
	u := testUser()
	before := time.Now().UTC().Add(-time.Second)
	createTestUser(t, s, u)
	after := time.Now().UTC()

	var email, normalized, createdAt, changedAt string
	err := s.db.QueryRowContext(t.Context(), `
		SELECT u.email, u.email_normalized, u.created_at, p.changed_at
		FROM users u JOIN password_credentials p ON p.user_id = u.id
		WHERE u.id = ?`, u.ID).Scan(&email, &normalized, &createdAt, &changedAt)
	if err != nil {
		t.Fatalf("read inserted fields: %v", err)
	}
	if email != u.Email || normalized != u.EmailNormalized {
		t.Fatal("store changed email inputs")
	}
	requireTimestampBetween(t, createdAt, before, after)
	requireTimestampBetween(t, changedAt, before, after)
	c, err := s.FindCredentialByEmail(t.Context(), u.EmailNormalized)
	if err != nil {
		t.Fatalf("FindCredentialByEmail() failed: %v", err)
	}
	if c.UserID != u.ID || c.PasswordHash != u.PasswordHash {
		t.Fatal("credential does not preserve ID and PHC representation")
	}
	for _, email := range []string{"missing@example.test", strings.ToLower(u.EmailNormalized), u.Email} {
		if _, err := s.FindCredentialByEmail(t.Context(), email); !errors.Is(err, auth.ErrUserNotFound) {
			t.Fatalf("lookup without an exact normalized match: got %v, want ErrUserNotFound", err)
		}
	}
}

func TestCreateUserConstraintErrors(t *testing.T) {
	tests := []struct {
		name   string
		change func(*auth.NewUser)
		taken  bool
	}{
		{"duplicate_email", func(u *auth.NewUser) { u.ID = "different-user" }, true},
		{"duplicate_id", func(u *auth.NewUser) { u.EmailNormalized = "different@example.test" }, false},
		{"duplicate_id_and_email", func(u *auth.NewUser) {}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			u := testUser()
			createTestUser(t, s, u)
			tt.change(&u)
			err := s.CreateUser(t.Context(), u)
			requireSafeError(t, err, u.ID, u.Email, u.EmailNormalized, u.PasswordHash)
			if errors.Is(err, auth.ErrEmailTaken) != tt.taken {
				t.Fatalf("ErrEmailTaken match = %t, want %t", errors.Is(err, auth.ErrEmailTaken), tt.taken)
			}
			requireRowCount(t, s, "SELECT count(*) FROM users", 1)
			requireRowCount(t, s, "SELECT count(*) FROM password_credentials", 1)
		})
	}
}

func TestCreateUserRollsBackCredentialFailure(t *testing.T) {
	s := newTestStore(t)
	_, err := s.db.ExecContext(t.Context(), `
		CREATE TRIGGER reject_credentials BEFORE INSERT ON password_credentials
		BEGIN SELECT RAISE(ABORT, 'credential insertion rejected'); END`)
	if err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}
	u := testUser()
	err = s.CreateUser(t.Context(), u)
	requireSafeError(t, err, u.ID, u.Email, u.EmailNormalized, u.PasswordHash)
	if errors.Is(err, auth.ErrEmailTaken) {
		t.Fatal("credential insertion failure reported as duplicate email")
	}
	requireRowCount(t, s, "SELECT count(*) FROM users", 0)
	requireRowCount(t, s, "SELECT count(*) FROM password_credentials", 0)
	if _, err := s.db.ExecContext(t.Context(), "DROP TRIGGER reject_credentials"); err != nil {
		t.Fatalf("drop failure trigger: %v", err)
	}
	createTestUser(t, s, u)
}

func TestUpdatePasswordHash(t *testing.T) {
	s := newTestStore(t)
	u := testUser()
	createTestUser(t, s, u)
	const oldTime = "2000-01-01T00:00:00.000Z"
	if _, err := s.db.ExecContext(t.Context(), "UPDATE password_credentials SET changed_at = ? WHERE user_id = ?", oldTime, u.ID); err != nil {
		t.Fatalf("seed old change time: %v", err)
	}
	const replacement = "unparsed replacement hash"
	before := time.Now().UTC().Add(-time.Second)
	if err := s.UpdatePasswordHash(t.Context(), u.ID, replacement); err != nil {
		t.Fatalf("UpdatePasswordHash() failed: %v", err)
	}
	after := time.Now().UTC()
	c, err := s.FindCredentialByEmail(t.Context(), u.EmailNormalized)
	if err != nil {
		t.Fatalf("find updated credential: %v", err)
	}
	if c.UserID != u.ID || c.PasswordHash != replacement {
		t.Fatal("updated credential does not preserve ID and supplied hash")
	}
	var changedAt string
	if err := s.db.QueryRowContext(t.Context(), "SELECT changed_at FROM password_credentials WHERE user_id = ?", u.ID).Scan(&changedAt); err != nil {
		t.Fatalf("read change time: %v", err)
	}
	requireTimestampBetween(t, changedAt, before, after)
	if err := s.UpdatePasswordHash(t.Context(), "missing-user", replacement); !errors.Is(err, auth.ErrUserNotFound) {
		t.Fatalf("update absent credential: got %v, want ErrUserNotFound", err)
	}
	if _, err := s.db.ExecContext(t.Context(), "DELETE FROM password_credentials WHERE user_id = ?", u.ID); err != nil {
		t.Fatalf("remove credential: %v", err)
	}
	if err := s.UpdatePasswordHash(t.Context(), u.ID, replacement); !errors.Is(err, auth.ErrUserNotFound) {
		t.Fatalf("update user without credential: got %v, want ErrUserNotFound", err)
	}
}

func TestSchemaConstraintsAndCascade(t *testing.T) {
	s := newTestStore(t)
	u := testUser()
	createTestUser(t, s, u)
	for _, table := range []string{"users", "password_credentials"} {
		var strict int
		if err := s.db.QueryRowContext(t.Context(), "SELECT strict FROM pragma_table_list WHERE name = ?", table).Scan(&strict); err != nil {
			t.Fatalf("read table strictness: %v", err)
		}
		if strict != 1 {
			t.Fatalf("%s is not a STRICT table", table)
		}
	}
	tests := []struct {
		name  string
		query string
		args  []any
	}{
		{"user_blob", "UPDATE users SET email = ? WHERE id = ?", []any{[]byte("blob"), u.ID}},
		{"credential_blob", "UPDATE password_credentials SET hash = ? WHERE user_id = ?", []any{[]byte("blob"), u.ID}},
		{"user_id_null", "INSERT INTO users (id, email, email_normalized) VALUES (NULL, 'other', 'other')", nil},
		{"email_null", "UPDATE users SET email = NULL WHERE id = ?", []any{u.ID}},
		{"normalized_null", "UPDATE users SET email_normalized = NULL WHERE id = ?", []any{u.ID}},
		{"hash_null", "UPDATE password_credentials SET hash = NULL WHERE user_id = ?", []any{u.ID}},
		{"credential_id_null", "INSERT INTO password_credentials (user_id, hash) VALUES (NULL, 'hash')", nil},
		{"foreign_key", "INSERT INTO password_credentials (user_id, hash) VALUES ('missing', 'hash')", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := s.db.ExecContext(t.Context(), tt.query, tt.args...); err == nil {
				t.Fatal("schema accepted a constraint violation")
			}
		})
	}
	if _, err := s.db.ExecContext(t.Context(), "DELETE FROM users WHERE id = ?", u.ID); err != nil {
		t.Fatalf("delete user: %v", err)
	}
	requireRowCount(t, s, "SELECT count(*) FROM users", 0)
	requireRowCount(t, s, "SELECT count(*) FROM password_credentials", 0)
}

func TestConnectionSettingsAndImmediateTransactions(t *testing.T) {
	s := newTestStore(t)
	s.db.SetMaxOpenConns(2)
	first, err := s.db.Conn(t.Context())
	if err != nil {
		t.Fatalf("acquire first connection: %v", err)
	}
	defer first.Close()
	second, err := s.db.Conn(t.Context())
	if err != nil {
		t.Fatalf("acquire second connection: %v", err)
	}
	defer second.Close()
	for _, conn := range []*sql.Conn{first, second} {
		for _, setting := range []struct {
			name string
			want string
		}{
			{"foreign_keys", "1"},
			{"journal_mode", "wal"},
			{"busy_timeout", "5000"},
		} {
			var got string
			if err := conn.QueryRowContext(t.Context(), "PRAGMA "+setting.name).Scan(&got); err != nil {
				t.Fatalf("read %s: %v", setting.name, err)
			}
			if got != setting.want {
				t.Fatalf("%s = %q, want %q", setting.name, got, setting.want)
			}
		}
	}
	if _, err := second.ExecContext(t.Context(), "PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("disable waiting on contending test connection: %v", err)
	}
	tx, err := first.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatalf("begin first transaction: %v", err)
	}
	defer tx.Rollback()
	other, err := second.BeginTx(t.Context(), nil)
	if err == nil {
		other.Rollback()
		t.Fatal("second transaction acquired a write lock while the first transaction was open")
	}
	var sqliteErr *sqlitedriver.Error
	if !errors.As(err, &sqliteErr) || sqliteErr.Code()&0xff != sqlite3.SQLITE_BUSY {
		t.Fatalf("contending immediate transaction: got %v, want SQLITE_BUSY", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("release first transaction: %v", err)
	}
	other, err = second.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatalf("begin transaction after releasing write lock: %v", err)
	}
	if err := other.Rollback(); err != nil {
		t.Fatalf("release second transaction: %v", err)
	}
}

func TestRequireWAL(t *testing.T) {
	s := newTestStore(t)
	if err := requireWAL(t.Context(), s.db); err != nil {
		t.Fatalf("requireWAL() rejected the store database: %v", err)
	}
	db, err := sql.Open("sqlite", filepath.Join(privateTestDir(t), "rollback.db"))
	if err != nil {
		t.Fatalf("open rollback journal database: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := requireWAL(t.Context(), db); err == nil {
		t.Fatal("requireWAL() accepted a rollback journal database")
	}
}

func TestOpenPaths(t *testing.T) {
	t.Run("escaped_filename", func(t *testing.T) {
		path := filepath.Join(privateTestDir(t), "auth ?_pragma=foreign_keys(0)# 100%.db")
		s := openTestStore(t, path)
		createTestUser(t, s, testUser())
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("database not created at the literal filename: %v", err)
		}
		var enabled int
		if err := s.db.QueryRowContext(t.Context(), "PRAGMA foreign_keys").Scan(&enabled); err != nil || enabled != 1 {
			t.Fatal("filename altered connection settings")
		}
	})
	t.Run("relative_path", func(t *testing.T) {
		dir := privateTestDir(t)
		t.Chdir(dir)
		s := openTestStore(t, "relative.db")
		createTestUser(t, s, testUser())
		if _, err := os.Stat(filepath.Join(dir, "relative.db")); err != nil {
			t.Fatalf("relative database was not created in the working directory: %v", err)
		}
	})
}

func TestOpenRejectsInvalidPathOrSchema(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, dir string) string
	}{
		{"empty", func(t *testing.T, dir string) string { return "" }},
		{"directory", func(t *testing.T, dir string) string { return dir }},
		{"missing_parent", func(t *testing.T, dir string) string { return filepath.Join(dir, "absent", "auth.db") }},
		{"invalid_database", func(t *testing.T, dir string) string {
			path := filepath.Join(dir, "auth.db")
			if err := os.WriteFile(path, []byte("this is not a SQLite database"), 0600); err != nil {
				t.Fatalf("write invalid database: %v", err)
			}
			return path
		}},
		{"conflicting_schema", func(t *testing.T, dir string) string {
			path := filepath.Join(dir, "auth.db")
			if err := os.WriteFile(path, nil, 0600); err != nil {
				t.Fatalf("create private schema fixture: %v", err)
			}
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatalf("open schema fixture: %v", err)
			}
			_, execErr := db.ExecContext(t.Context(), "CREATE TABLE existing (value TEXT); CREATE INDEX users ON existing(value)")
			closeErr := db.Close()
			if execErr != nil || closeErr != nil {
				t.Fatalf("prepare conflicting schema: exec=%v close=%v", execErr, closeErr)
			}
			return path
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := privateTestDir(t)
			s, err := Open(t.Context(), tt.setup(t, dir))
			if s != nil {
				s.Close()
				t.Fatal("Open() returned a store for an invalid path or schema")
			}
			if err == nil {
				t.Fatal("Open() accepted an invalid path or schema")
			}
			if _, err := os.Stat(filepath.Join(dir, "absent")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("Open() created a missing parent directory: %v", err)
			}
			for _, pattern := range []string{"*-wal", "*-shm"} {
				leftovers, err := filepath.Glob(filepath.Join(dir, pattern))
				if err != nil {
					t.Fatalf("list %s files: %v", pattern, err)
				}
				if len(leftovers) != 0 {
					t.Fatalf("Open() left the connection pool open: %v remain", leftovers)
				}
			}
		})
	}
}

func TestCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	s, err := Open(ctx, filepath.Join(privateTestDir(t), "canceled.db"))
	if s != nil {
		s.Close()
		t.Fatal("Open() returned a store for a canceled context")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Open() with canceled context: got %v, want context.Canceled", err)
	}

	s = newTestStore(t)
	u := testUser()
	createTestUser(t, s, u)
	other := u
	other.ID = "canceled-user"
	other.EmailNormalized = "canceled@example.test"
	tests := []struct {
		name string
		call func() error
	}{
		{"create", func() error { return s.CreateUser(ctx, other) }},
		{"find", func() error { _, err := s.FindCredentialByEmail(ctx, u.EmailNormalized); return err }},
		{"update", func() error { return s.UpdatePasswordHash(ctx, u.ID, "canceled replacement") }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call()
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("canceled call: got %v, want context.Canceled", err)
			}
			requireSafeError(t, err, u.ID, u.Email, u.EmailNormalized, u.PasswordHash)
		})
	}
	requireRowCount(t, s, "SELECT count(*) FROM users", 1)
	c, err := s.FindCredentialByEmail(t.Context(), u.EmailNormalized)
	if err != nil {
		t.Fatalf("find after canceled operations: %v", err)
	}
	if c.PasswordHash != u.PasswordHash {
		t.Fatal("canceled update changed the stored hash")
	}
}

func TestWriteLockContention(t *testing.T) {
	calls := []struct {
		name string
		call func(ctx context.Context, s *Store, u auth.NewUser) error
	}{
		{"create", func(ctx context.Context, s *Store, u auth.NewUser) error {
			u.ID = "waiting-user"
			u.EmailNormalized = "waiting@example.test"
			return s.CreateUser(ctx, u)
		}},
		{"update", func(ctx context.Context, s *Store, u auth.NewUser) error {
			return s.UpdatePasswordHash(ctx, u.ID, "waiting replacement")
		}},
	}
	for _, c := range calls {
		t.Run(c.name+"_busy", func(t *testing.T) {
			s := newTestStore(t)
			u := testUser()
			createTestUser(t, s, u)
			holdWriteLock(t, s, 0)
			err := c.call(t.Context(), s, u)
			requireSafeError(t, err, u.ID, u.Email, u.EmailNormalized, u.PasswordHash)
			if !errors.Is(err, auth.ErrBusy) {
				t.Fatalf("lock timeout: got %v, want ErrBusy", err)
			}
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("lock timeout reported as a context error: %v", err)
			}
		})
		t.Run(c.name+"_deadline_while_waiting", func(t *testing.T) {
			s := newTestStore(t)
			u := testUser()
			createTestUser(t, s, u)
			holdWriteLock(t, s, 1000)
			ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
			defer cancel()
			err := c.call(ctx, s, u)
			requireSafeError(t, err, u.ID, u.Email, u.EmailNormalized, u.PasswordHash)
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("deadline during lock wait: got %v, want context.DeadlineExceeded", err)
			}
		})
	}
}

func TestClosedStoreErrors(t *testing.T) {
	s := newTestStore(t)
	u := testUser()
	if err := s.Close(); err != nil {
		t.Fatalf("Close(): %v", err)
	}
	tests := []struct {
		name string
		call func() error
	}{
		{"create", func() error { return s.CreateUser(t.Context(), u) }},
		{"find", func() error { _, err := s.FindCredentialByEmail(t.Context(), u.EmailNormalized); return err }},
		{"update", func() error { return s.UpdatePasswordHash(t.Context(), u.ID, u.PasswordHash) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call()
			requireSafeError(t, err, u.ID, u.Email, u.EmailNormalized, u.PasswordHash)
			if errors.Is(err, auth.ErrUserNotFound) || errors.Is(err, auth.ErrEmailTaken) || errors.Is(err, auth.ErrBusy) {
				t.Fatal("closed database reported as a normal domain error")
			}
		})
	}
}
