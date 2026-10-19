package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func testListener(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	return listener
}

func TestServerConfiguration(t *testing.T) {
	srv := newServer(9000, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), testLogger())
	if srv.Addr != ":9000" || srv.ReadHeaderTimeout != 5*time.Second ||
		srv.ReadTimeout != 10*time.Second || srv.WriteTimeout != 30*time.Second || srv.IdleTimeout != 60*time.Second {
		t.Fatalf("unexpected server configuration: %+v", srv)
	}
	if srv.ErrorLog == nil {
		t.Fatal("server logs must use the JSON logger")
	}
}

func TestServeDrainsActiveRequests(t *testing.T) {
	for _, acceptFailure := range []bool{false, true} {
		name := "cancellation"
		if acceptFailure {
			name = "listener failure"
		}
		t.Run(name, func(t *testing.T) { testServeDrainsRequest(t, acceptFailure) })
	}
}

func testServeDrainsRequest(t *testing.T, acceptFailure bool) {
	t.Helper()
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	srv := newServer(8080, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
	}), testLogger())
	t.Cleanup(func() { srv.Close() })
	shutdownStarted := make(chan struct{})
	srv.RegisterOnShutdown(func() { close(shutdownStarted) })
	listener := testListener(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- serve(ctx, srv, listener) }()
	client := &http.Client{Timeout: 5 * time.Second}
	requestResult := make(chan error, 1)
	go func() {
		response, err := client.Get("http://" + listener.Addr().String())
		if err == nil {
			response.Body.Close()
			if response.StatusCode != http.StatusNoContent {
				err = errors.New("active request did not complete normally")
			}
		}
		requestResult <- err
	}()
	awaitSignal(t, started)
	if acceptFailure {
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
	} else {
		cancel()
	}
	awaitSignal(t, shutdownStarted)
	unblock()
	if err := <-requestResult; err != nil {
		t.Fatal(err)
	}
	if err := <-result; (err != nil) != acceptFailure {
		t.Fatalf("serve error = %v, want listener failure = %t", err, acceptFailure)
	}
}

func awaitSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("server did not reach expected lifecycle state")
	}
}

func TestShutdownClosesConnectionsWhenDeadlineExpires(t *testing.T) {
	started := make(chan struct{})
	finished := make(chan struct{})
	srv := newServer(8080, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(finished)
	}), testLogger())
	t.Cleanup(func() { srv.Close() })
	listener := testListener(t)
	serveResult := make(chan error, 1)
	go func() { serveResult <- srv.Serve(listener) }()
	requestResult := make(chan error, 1)
	go func() {
		client := &http.Client{Timeout: 5 * time.Second}
		response, err := client.Get("http://" + listener.Addr().String())
		if err == nil {
			response.Body.Close()
		}
		requestResult <- err
	}()
	awaitSignal(t, started)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if err := shutdownServer(ctx, srv); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown error = %v, want deadline exceeded", err)
	}
	awaitSignal(t, finished)
	if err := <-requestResult; err == nil {
		t.Fatal("active connection must be closed after deadline")
	}
	if err := <-serveResult; !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("serve error = %v", err)
	}
}

func TestServeReturnsListenerFailure(t *testing.T) {
	listener := testListener(t)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	srv := newServer(8080, http.NotFoundHandler(), testLogger())
	if err := serve(context.Background(), srv, listener); err == nil {
		t.Fatal("listener failure was ignored")
	}
}

func TestRunRejectsConfigurationBeforeCreatingDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.db")
	t.Setenv("DATABASE_PATH", path)
	t.Setenv("PORT", "0")
	if err := run(context.Background(), testLogger()); err == nil {
		t.Fatal("invalid configuration accepted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("database created before configuration was validated")
	}
	t.Setenv("DATABASE_PATH", "/mnt/c/auth-server-test.db")
	t.Setenv("PORT", "8080")
	if err := run(context.Background(), testLogger()); err == nil {
		t.Fatal("Windows database path accepted")
	}
}
