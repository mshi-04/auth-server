package sqlite

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"

	"auth-server/internal/auth"

	sqlitedriver "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

//go:embed init.sql
var initSQL string

type Store struct {
	db *sql.DB
}

var _ auth.UserStore = (*Store)(nil)

func Open(ctx context.Context, path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("open sqlite: empty database path")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve database path: %w", err)
	}
	if err := prepareDatabaseFile(ctx, absPath); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: absPath}
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(5000)")
	q.Set("_txlock", "immediate")
	u.RawQuery = q.Encode()

	db, err := openDatabase(ctx, u.String())
	if err != nil {
		return nil, fmt.Errorf("connect sqlite: %w", err)
	}
	if err := requireWAL(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.ExecContext(ctx, initSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize sqlite schema: %w", err)
	}
	return &Store{db: db}, nil
}

func requireWAL(ctx context.Context, db *sql.DB) error {
	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		return fmt.Errorf("read sqlite journal mode: %w", err)
	}
	if mode != "wal" {
		return fmt.Errorf("sqlite journal mode is %q, want wal", mode)
	}
	return nil
}

func (s *Store) Close() error {
	if err := s.db.Close(); err != nil {
		return fmt.Errorf("close sqlite: %w", err)
	}
	return nil
}

func (s *Store) CreateUser(ctx context.Context, u auth.NewUser) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return wrapError(ctx, "begin create user transaction", err)
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx,
		`INSERT INTO users (id, email, email_normalized) VALUES (?, ?, ?)`,
		u.ID, u.Email, u.EmailNormalized)
	if hasCode(err, sqlite3.SQLITE_CONSTRAINT_UNIQUE) {
		return fmt.Errorf("insert user: %w", auth.ErrEmailTaken)
	}
	if err != nil {
		return wrapError(ctx, "insert user", err)
	}
	_, err = tx.ExecContext(ctx,
		`INSERT INTO password_credentials (user_id, hash) VALUES (?, ?)`,
		u.ID, u.PasswordHash)
	if err != nil {
		return wrapError(ctx, "insert password credential", err)
	}
	if err := tx.Commit(); err != nil {
		return wrapError(ctx, "commit create user transaction", err)
	}
	return nil
}

func (s *Store) FindCredentialByEmail(ctx context.Context, emailNormalized string) (auth.Credential, error) {
	var c auth.Credential
	err := s.db.QueryRowContext(ctx,
		`SELECT c.user_id, c.hash
		 FROM users AS u
		 JOIN password_credentials AS c ON c.user_id = u.id
		 WHERE u.email_normalized = ?`, emailNormalized).Scan(&c.UserID, &c.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return auth.Credential{}, fmt.Errorf("find password credential: %w", auth.ErrUserNotFound)
	}
	if err != nil {
		return auth.Credential{}, wrapError(ctx, "find password credential", err)
	}
	return c, nil
}

func (s *Store) UpdatePasswordHash(ctx context.Context, userID, passwordHash string) error {
	result, err := s.db.ExecContext(ctx,
		`UPDATE password_credentials
		 SET hash = ?, changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		 WHERE user_id = ?`, passwordHash, userID)
	if err != nil {
		return wrapError(ctx, "update password hash", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return wrapError(ctx, "count updated password credentials", err)
	}
	if count == 0 {
		return fmt.Errorf("update password hash: %w", auth.ErrUserNotFound)
	}
	return nil
}

func hasCode(err error, code int) bool {
	var sqliteErr *sqlitedriver.Error
	return errors.As(err, &sqliteErr) && sqliteErr.Code() == code
}

func wrapError(ctx context.Context, action string, err error) error {
	var sqliteErr *sqlitedriver.Error
	if errors.As(err, &sqliteErr) && sqliteErr.Code()&0xff == sqlite3.SQLITE_BUSY {
		err = fmt.Errorf("%w: %w", auth.ErrBusy, err)
	}
	// modernc.org/sqlite はトランザクション開始の失敗を ctx のエラーに変換しない。
	if ctxErr := ctx.Err(); ctxErr != nil && !errors.Is(err, ctxErr) {
		err = fmt.Errorf("%w: %w", err, ctxErr)
	}
	return fmt.Errorf("%s: %w", action, err)
}
