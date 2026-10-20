package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	DatabasePath string
	Port         int
}

func Load() (Config, error) {
	path, err := databasePath(os.Getenv("DATABASE_PATH"))
	if err != nil {
		return Config{}, fmt.Errorf("load configuration: %w", err)
	}
	port, err := parsePort(os.Getenv("PORT"))
	if err != nil {
		return Config{}, fmt.Errorf("load configuration: %w", err)
	}
	return Config{DatabasePath: path, Port: port}, nil
}

func databasePath(raw string) (string, error) {
	if raw == "" {
		return "", errors.New("DATABASE_PATH is required")
	}
	path, err := filepath.Abs(raw)
	if err != nil {
		return "", fmt.Errorf("resolve DATABASE_PATH: %w", err)
	}
	if onWindowsDrive(path) {
		return "", errors.New("DATABASE_PATH must not be under /mnt/c")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if errors.Is(err, os.ErrNotExist) {
		if _, statErr := os.Lstat(path); statErr == nil {
			return "", fmt.Errorf("resolve DATABASE_PATH links: %w", err)
		}
		parent, parentErr := filepath.EvalSymlinks(filepath.Dir(path))
		if parentErr != nil {
			return "", fmt.Errorf("resolve DATABASE_PATH parent: %w", parentErr)
		}
		resolved = filepath.Join(parent, filepath.Base(path))
		err = nil
	}
	if err != nil {
		return "", fmt.Errorf("resolve DATABASE_PATH links: %w", err)
	}
	if onWindowsDrive(resolved) {
		return "", errors.New("DATABASE_PATH must not resolve under /mnt/c")
	}
	return path, nil
}

func onWindowsDrive(path string) bool {
	return path == "/mnt/c" || strings.HasPrefix(path, "/mnt/c/")
}

func parsePort(raw string) (int, error) {
	if raw == "" {
		return 8080, nil
	}
	port, err := strconv.ParseUint(raw, 10, 16)
	if err != nil || port == 0 {
		return 0, errors.New("PORT must be decimal digits between 1 and 65535")
	}
	return int(port), nil
}
