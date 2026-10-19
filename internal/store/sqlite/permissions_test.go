package sqlite

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestOpenCreatesPrivateDatabaseAndSidecars(t *testing.T) {
	const childEnv = "AUTH_SERVER_PRIVATE_DATABASE_TEST_CHILD"
	if os.Getenv(childEnv) != "1" {
		cmd := exec.Command(os.Args[0], "-test.run=^TestOpenCreatesPrivateDatabaseAndSidecars$")
		cmd.Env = append(os.Environ(), childEnv+"=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("permission subprocess failed: %v\n%s", err, output)
		}
		return
	}
	// umask is process-wide, so only the isolated subprocess changes it.
	syscall.Umask(0022)
	dir := privateTestDir(t)
	path := filepath.Join(dir, "private.db")
	s := openTestStore(t, path)
	u := testUser()
	createTestUser(t, s, u)
	for _, suffix := range []string{"", "-wal", "-shm"} {
		info, err := os.Lstat(path + suffix)
		if err != nil {
			t.Fatalf("inspect database%s: %v", suffix, err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatalf("database%s permissions = %04o, want 0600", suffix, info.Mode().Perm())
		}
		if err := requirePrivateOwnership(info); err != nil {
			t.Fatalf("database%s ownership: %v", suffix, err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatalf("close private database: %v", err)
	}
	reopened := openTestStore(t, path)
	c, err := reopened.FindCredentialByEmail(t.Context(), u.EmailNormalized)
	if err != nil || c.UserID != u.ID || c.PasswordHash != u.PasswordHash {
		t.Fatalf("private database did not reopen with its data: %v", err)
	}
	probe := filepath.Join(dir, "umask-probe")
	if err := os.WriteFile(probe, nil, 0666); err != nil {
		t.Fatalf("create umask probe: %v", err)
	}
	info, err := os.Stat(probe)
	if err != nil {
		t.Fatalf("inspect umask probe: %v", err)
	}
	if info.Mode().Perm() != 0644 {
		t.Fatalf("Open changed process umask: probe permissions = %04o, want 0644", info.Mode().Perm())
	}
}

func TestOpenRejectsAccessibleDirectory(t *testing.T) {
	for _, mode := range []os.FileMode{0750, 0704, 0701} {
		t.Run(mode.String(), func(t *testing.T) {
			dir := privateTestDir(t)
			if err := os.Chmod(dir, mode); err != nil {
				t.Fatalf("make directory accessible: %v", err)
			}
			path := filepath.Join(dir, "auth.db")
			requireOpenPermissionError(t, path)
			if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("Open created database in accessible directory: %v", err)
			}
			info, err := os.Stat(dir)
			if err != nil || info.Mode().Perm() != mode {
				t.Fatalf("Open changed directory permissions: stat error = %v", err)
			}
		})
	}
}

func TestOpenRejectsAccessibleDatabaseFiles(t *testing.T) {
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		t.Run("database"+suffix, func(t *testing.T) {
			path := filepath.Join(privateTestDir(t), "auth.db")
			filename := path + suffix
			original := []byte("existing file must remain unchanged")
			if err := os.WriteFile(filename, original, 0600); err != nil {
				t.Fatalf("create existing file: %v", err)
			}
			if err := os.Chmod(filename, 0644); err != nil {
				t.Fatalf("make file accessible: %v", err)
			}
			requireOpenPermissionError(t, path)
			got, err := os.ReadFile(filename)
			if err != nil || !bytes.Equal(got, original) {
				t.Fatalf("Open changed rejected file content: read error = %v", err)
			}
			info, err := os.Stat(filename)
			if err != nil || info.Mode().Perm() != 0644 {
				t.Fatalf("Open changed rejected file permissions: stat error = %v", err)
			}
			if suffix != "" {
				if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("Open created database before checking sidecar: %v", err)
				}
			}
		})
	}
}

func TestOpenRejectsLinkedOrNonregularPaths(t *testing.T) {
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		t.Run("symlink"+suffix, func(t *testing.T) {
			path := filepath.Join(privateTestDir(t), "auth.db")
			target := filepath.Join(privateTestDir(t), "outside")
			original := []byte("symlink target must remain unchanged")
			if err := os.WriteFile(target, original, 0600); err != nil {
				t.Fatalf("create external target: %v", err)
			}
			if err := os.Symlink(target, path+suffix); err != nil {
				t.Fatalf("create database symlink: %v", err)
			}
			requireOpenPermissionError(t, path)
			got, err := os.ReadFile(target)
			if err != nil || !bytes.Equal(got, original) {
				t.Fatalf("Open changed symlink target: read error = %v", err)
			}
		})
		t.Run("directory"+suffix, func(t *testing.T) {
			path := filepath.Join(privateTestDir(t), "auth.db")
			if err := os.Mkdir(path+suffix, 0700); err != nil {
				t.Fatalf("create nonregular database path: %v", err)
			}
			requireOpenPermissionError(t, path)
		})
	}
	t.Run("parent_symlink", func(t *testing.T) {
		link := filepath.Join(privateTestDir(t), "linked")
		target := privateTestDir(t)
		if err := os.Symlink(target, link); err != nil {
			t.Fatalf("create parent symlink: %v", err)
		}
		requireOpenPermissionError(t, filepath.Join(link, "auth.db"))
		if _, err := os.Lstat(filepath.Join(target, "auth.db")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("Open created database through parent symlink: %v", err)
		}
	})
}

func TestPrepareDatabaseFileCanceledContextCreatesNothing(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	path := filepath.Join(privateTestDir(t), "auth.db")
	if err := prepareDatabaseFile(ctx, path); !errors.Is(err, context.Canceled) {
		t.Fatalf("prepareDatabaseFile() = %v, want context.Canceled", err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled preparation created database: %v", err)
	}
}

func TestPrivateOwnershipRejectsForeignOwner(t *testing.T) {
	for _, directory := range []bool{false, true} {
		path := privateTestDir(t)
		if !directory {
			path = filepath.Join(path, "auth.db")
			if err := os.WriteFile(path, nil, 0600); err != nil {
				t.Fatalf("create ownership fixture: %v", err)
			}
		}
		info, err := os.Lstat(path)
		if err != nil {
			t.Fatalf("inspect ownership fixture: %v", err)
		}
		stat := *info.Sys().(*syscall.Stat_t)
		stat.Uid++
		if err := requirePrivateOwnership(ownershipFileInfo{FileInfo: info, stat: &stat}); err == nil {
			t.Fatal("private permissions accepted a foreign owner")
		}
	}
}

type ownershipFileInfo struct {
	os.FileInfo
	stat *syscall.Stat_t
}

func (i ownershipFileInfo) Sys() any { return i.stat }

func requireOpenPermissionError(t *testing.T, path string) {
	t.Helper()
	s, err := Open(t.Context(), path)
	if s != nil {
		s.Close()
		t.Fatal("Open returned a store for an unsafe filesystem path")
	}
	if err == nil {
		t.Fatal("Open accepted an unsafe filesystem path")
	}
	if !strings.Contains(err.Error(), "sqlite database") {
		t.Fatalf("Open did not identify filesystem validation: %v", err)
	}
}
