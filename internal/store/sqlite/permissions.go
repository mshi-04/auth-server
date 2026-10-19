package sqlite

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func prepareDatabaseFile(ctx context.Context, path string) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("prepare sqlite database: %w", err)
	}
	dir, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("inspect sqlite database directory: %w", err)
	}
	if !dir.IsDir() {
		return errors.New("sqlite database parent must be a real directory")
	}
	if err := requirePrivateOwnership(dir); err != nil {
		return fmt.Errorf("sqlite database directory: %w", err)
	}
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if err := checkDatabaseFile(path + suffix); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("prepare sqlite database: %w", err)
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return checkDatabaseFile(path)
	}
	if err != nil {
		return fmt.Errorf("create private sqlite database: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close new sqlite database: %w", err)
	}
	return nil
}

func checkDatabaseFile(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect sqlite database file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return errors.New("sqlite database and sidecars must be regular files")
	}
	if err := requirePrivateOwnership(info); err != nil {
		return fmt.Errorf("sqlite database file: %w", err)
	}
	return nil
}

func requirePrivateOwnership(info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) {
		return errors.New("owner must match the effective user")
	}
	if info.Mode().Perm()&0077 != 0 {
		return errors.New("group and other permissions must be disabled")
	}
	return nil
}
