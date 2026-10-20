package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
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
	var logs bytes.Buffer
	srv := newServer(9000, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), slog.New(slog.NewJSONHandler(&logs, nil)))
	if srv.Addr != ":9000" || srv.ReadHeaderTimeout != 5*time.Second ||
		srv.ReadTimeout != 10*time.Second || srv.WriteTimeout != 30*time.Second || srv.IdleTimeout != 60*time.Second {
		t.Fatalf("unexpected server configuration: %+v", srv)
	}
	srv.ErrorLog.Print("server failure")
	var record map[string]any
	if err := json.Unmarshal(logs.Bytes(), &record); err != nil || record["level"] != "ERROR" || record["msg"] != "server failure" {
		t.Fatalf("server logs must use the JSON logger at ERROR level: %q", logs.String())
	}
}

func TestSignalContextCancelsOnSIGTERM(t *testing.T) {
	ctx, stop := signalContext()
	defer stop()
	process, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if err := process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	awaitSignal(t, ctx.Done())
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
	if err := run(context.Background(), testLogger()); err == nil || !strings.Contains(err.Error(), "load configuration") {
		t.Fatalf("run error = %v, want configuration rejection", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("database created before configuration was validated")
	}
	t.Setenv("DATABASE_PATH", "/mnt/c/auth-server-test.db")
	t.Setenv("PORT", "8080")
	if err := run(context.Background(), testLogger()); err == nil || !strings.Contains(err.Error(), "load configuration") {
		t.Fatalf("run error = %v, want configuration rejection of the Windows database path", err)
	}
}

func testDatabasePath(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "auth.db")
}

func assertDatabaseClosed(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("database was not created: %v", err)
	}
	if _, err := os.Stat(path + "-wal"); !os.IsNotExist(err) {
		t.Error("database was not closed: WAL file remains")
	}
}

func TestRunServesUntilCanceledAndClosesDatabase(t *testing.T) {
	listener := testListener(t)
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	path := testDatabasePath(t)
	t.Setenv("DATABASE_PATH", path)
	t.Setenv("PORT", strconv.Itoa(port))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- run(ctx, testLogger()) }()
	client := &http.Client{Timeout: 5 * time.Second}
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	deadline := time.Now().Add(10 * time.Second)
	for {
		response, err := client.Get(base + "/healthz")
		if err == nil {
			response.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("server did not start: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	response, err := client.Post(base+"/v1/users", "application/json",
		strings.NewReader(`{"email":"user@example.com","password":"correct horse battery staple"}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("registration status = %d, want 201", response.StatusCode)
	}
	cancel()
	if err := <-result; err != nil {
		t.Fatalf("run error = %v", err)
	}
	assertDatabaseClosed(t, path)
}

func TestRunClosesDatabaseWhenListenFails(t *testing.T) {
	occupied, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	path := testDatabasePath(t)
	t.Setenv("DATABASE_PATH", path)
	t.Setenv("PORT", strconv.Itoa(occupied.Addr().(*net.TCPAddr).Port))
	if err := run(context.Background(), testLogger()); err == nil || !strings.Contains(err.Error(), "listen HTTP") {
		t.Fatalf("run error = %v, want listen failure", err)
	}
	assertDatabaseClosed(t, path)
}
