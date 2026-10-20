package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.db")
	t.Setenv("DATABASE_PATH", path)
	t.Setenv("PORT", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DatabasePath != path || cfg.Port != 8080 {
		t.Fatalf("unexpected configuration: %+v", cfg)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("loading configuration must not create the database")
	}
	t.Setenv("PORT", "9000")
	cfg, err = Load()
	if err != nil || cfg.Port != 9000 {
		t.Fatalf("explicit port: %+v, %v", cfg, err)
	}
	t.Setenv("DATABASE_PATH", "")
	if _, err := Load(); err == nil {
		t.Fatal("empty DATABASE_PATH accepted")
	}
	t.Setenv("DATABASE_PATH", path)
	t.Setenv("PORT", "0")
	if _, err := Load(); err == nil {
		t.Fatal("invalid PORT accepted")
	}
}

func TestParsePort(t *testing.T) {
	for _, tt := range []struct {
		raw  string
		want int
	}{
		{"", 8080}, {"1", 1}, {"65535", 65535}, {"08080", 8080},
	} {
		t.Run(tt.raw, func(t *testing.T) {
			got, err := parsePort(tt.raw)
			if err != nil || got != tt.want {
				t.Fatalf("port = %d, err = %v; want %d", got, err, tt.want)
			}
		})
	}
	for _, raw := range []string{"0", "65536", "-1", "+80", " 80", "80 ", "1.5", "http", "８０", strings.Repeat("9", 100)} {
		t.Run(raw, func(t *testing.T) {
			if _, err := parsePort(raw); err == nil {
				t.Fatal("invalid port accepted")
			}
		})
	}
}

func TestDatabasePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "new.db")
	t.Chdir(dir)
	got, err := databasePath("new.db", windowsDriveRoot)
	if err != nil || got != path {
		t.Fatalf("relative path: %q, %v", got, err)
	}
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	got, err = databasePath(path, windowsDriveRoot)
	if err != nil || got != path {
		t.Fatalf("existing file: %q, %v", got, err)
	}
	for _, invalid := range []string{"", "/mnt/c", "/mnt/c/new.db", "/mnt/c/../c/new.db", filepath.Join(dir, "missing", "auth.db")} {
		if _, err := databasePath(invalid, windowsDriveRoot); err == nil {
			t.Fatalf("invalid path accepted: %q", invalid)
		}
	}
}

func TestDatabasePathResolvesLinksWithoutChangingReturnedPath(t *testing.T) {
	dir := t.TempDir()
	windowsRoot := filepath.Join(dir, "windows-drive")
	if err := os.Mkdir(windowsRoot, 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "windows")
	if err := os.Symlink(windowsRoot, link); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(link, "new.db"), link} {
		_, err := databasePath(path, windowsRoot)
		if err == nil || !strings.Contains(err.Error(), "must not resolve under") {
			t.Fatalf("Windows link %q: error = %v, want rejection after link resolution", path, err)
		}
	}
	fileLink := filepath.Join(dir, "file-link")
	if err := os.Symlink(filepath.Join(windowsRoot, "nonexistent", "auth.db"), fileLink); err != nil {
		t.Fatal(err)
	}
	if _, err := databasePath(fileLink, windowsRoot); err == nil {
		t.Fatal("dangling Windows file link accepted")
	}
	safe := filepath.Join(dir, "safe")
	if err := os.Mkdir(safe, 0700); err != nil {
		t.Fatal(err)
	}
	safeLink := filepath.Join(dir, "safe-link")
	if err := os.Symlink(safe, safeLink); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(safeLink, "auth.db")
	got, err := databasePath(path, windowsRoot)
	if err != nil || got != path {
		t.Fatalf("safe link must remain visible to store: %q, %v", got, err)
	}
}

func TestWindowsDriveBoundary(t *testing.T) {
	for _, tt := range []struct {
		path string
		want bool
	}{
		{"/mnt/c", true}, {"/mnt/c/auth.db", true},
		{"/mnt/copy/auth.db", false}, {"/mnt/c-other/auth.db", false}, {"/tmp/auth.db", false},
	} {
		if got := under(tt.path, windowsDriveRoot); got != tt.want {
			t.Fatalf("path %q: got %t, want %t", tt.path, got, tt.want)
		}
	}
}
