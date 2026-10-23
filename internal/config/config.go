package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const windowsDriveRoot = "/mnt/c"

type Config struct {
	DatabasePath string
	Port         int
}

func Load() (Config, error) {
	path, err := databasePath(os.Getenv("DATABASE_PATH"), windowsDriveRoot)
	if err != nil {
		return Config{}, fmt.Errorf("load configuration: %w", err)
	}
	port, err := parsePort(os.Getenv("PORT"))
	if err != nil {
		return Config{}, fmt.Errorf("load configuration: %w", err)
	}
	return Config{DatabasePath: path, Port: port}, nil
}

func databasePath(raw, windowsRoot string) (string, error) {
	if raw == "" {
		return "", errors.New("DATABASE_PATH is required")
	}
	path, err := filepath.Abs(raw)
	if err != nil {
		return "", fmt.Errorf("resolve DATABASE_PATH: %w", err)
	}
	if under(path, windowsRoot) {
		return "", fmt.Errorf("DATABASE_PATH must not be under %s", windowsRoot)
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
	if under(resolved, windowsRoot) {
		return "", fmt.Errorf("DATABASE_PATH must not resolve under %s", windowsRoot)
	}
	return path, nil
}

func under(path, root string) bool {
	return path == root || strings.HasPrefix(path, root+"/")
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
