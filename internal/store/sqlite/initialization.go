package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	sqlitedriver "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

const (
	openRetryTimeout  = 5 * time.Second
	openRetryInterval = 10 * time.Millisecond
)

func openDatabase(ctx context.Context, dsn string) (*sql.DB, error) {
	deadline := time.Now().Add(openRetryTimeout)
	var lastErr error
	for {
		if err := ctx.Err(); err != nil {
			return nil, errors.Join(lastErr, err)
		}
		if lastErr != nil && !time.Now().Before(deadline) {
			return nil, lastErr
		}
		db, err := sql.Open("sqlite", dsn)
		if err != nil {
			return nil, err
		}
		err = db.PingContext(ctx)
		if err == nil {
			if err := ctx.Err(); err != nil {
				db.Close()
				return nil, err
			}
			return db, nil
		}
		lastErr = err
		db.Close()
		if err := ctx.Err(); err != nil {
			return nil, errors.Join(lastErr, err)
		}
		var sqliteErr *sqlitedriver.Error
		if !errors.As(lastErr, &sqliteErr) || sqliteErr.Code()&0xff != sqlite3.SQLITE_BUSY {
			return nil, lastErr
		}
		wait := min(openRetryInterval, time.Until(deadline))
		if wait <= 0 {
			return nil, lastErr
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, errors.Join(lastErr, ctx.Err())
		case <-timer.C:
		}
	}
}
