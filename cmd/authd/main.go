package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"auth-server/internal/auth"
	"auth-server/internal/config"
	"auth-server/internal/httpapi"
	"auth-server/internal/password"
	"auth-server/internal/store/sqlite"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, logger); err != nil {
		logger.Error("auth server failed", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, logger *slog.Logger) (err error) {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	store, err := sqlite.Open(ctx, cfg.DatabasePath)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, store.Close()) }()
	hasher, err := password.New(password.DefaultParams())
	if err != nil {
		return err
	}
	service, err := auth.NewService(store, hasher, logger)
	if err != nil {
		return err
	}
	srv := newServer(cfg.Port, httpapi.NewHandler(service, logger), logger)
	listener, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("listen HTTP: %w", err)
	}
	logger.Info("auth server listening", "address", srv.Addr)
	return serve(ctx, srv, listener)
}

func newServer(port int, handler http.Handler, logger *slog.Logger) *http.Server {
	return &http.Server{
		Addr:              net.JoinHostPort("", strconv.Itoa(port)),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
}

func serve(ctx context.Context, srv *http.Server, listener net.Listener) error {
	result := make(chan error, 1)
	go func() { result <- srv.Serve(listener) }()
	select {
	case err := <-result:
		return errors.Join(serveError(err), shutdownServer(context.Background(), srv))
	case <-ctx.Done():
		err := shutdownServer(context.Background(), srv)
		return errors.Join(err, serveError(<-result))
	}
}

func shutdownServer(ctx context.Context, srv *http.Server) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		return errors.Join(fmt.Errorf("shut down HTTP server: %w", err), srv.Close())
	}
	return nil
}

func serveError(err error) error {
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return fmt.Errorf("serve HTTP: %w", err)
}
