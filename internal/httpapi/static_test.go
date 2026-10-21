package httpapi_test

import (
	"bytes"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestIndexHTMLWorksUnderPolicy(t *testing.T) {
	html, err := os.ReadFile("web/index.html")
	if err != nil {
		t.Fatal(err)
	}
	form := regexp.MustCompile(`<form\b[^>]*\bid="auth-form"[^>]*>`).Find(html)
	if form == nil || !regexp.MustCompile(`\shidden[\s>]`).Match(form) {
		t.Errorf("auth form must be hidden until JavaScript runs: %s", form)
	}
	for _, script := range regexp.MustCompile(`<script\b([^>]*)>([^<]*)</script>`).FindAllSubmatch(html, -1) {
		if !bytes.Contains(script[1], []byte(" src=")) || len(bytes.TrimSpace(script[2])) != 0 {
			t.Errorf("index.html contains an inline script: %s", script[0])
		}
	}
	for _, inline := range []*regexp.Regexp{
		regexp.MustCompile(`<style\b`),
		regexp.MustCompile(`\sstyle\s*=`),
		regexp.MustCompile(`\son[a-z]+\s*=`),
	} {
		if match := inline.Find(html); match != nil {
			t.Errorf("index.html contains content blocked by the policy: %s", match)
		}
	}
	f := newFixture(t)
	policy := request(f.handler, http.MethodGet, "/", "").Header().Get("Content-Security-Policy")
	if policy == "" || strings.Contains(policy, "unsafe-") || strings.Contains(policy, "*") {
		t.Errorf("Content-Security-Policy = %q, want a policy without unsafe sources or wildcards", policy)
	}
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	for _, tt := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/healthz", ""},
		{http.MethodPost, "/v1/users", credentialsJSON(t, "user@example.com", testPassword)},
		{http.MethodPost, "/v1/sessions", "{}"},
		{http.MethodGet, "/missing", ""},
		{http.MethodDelete, "/v1/users", ""},
	} {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			f := newFixture(t)
			response := request(f.handler, tt.method, tt.path, tt.body)
			for name, value := range map[string]string{"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"} {
				if got := response.Header().Get(name); got != value {
					t.Errorf("%s = %q, want %q", name, got, value)
				}
			}
		})
	}
}

func TestStaticWebFiles(t *testing.T) {
	const policy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	for _, tt := range []struct {
		path        string
		file        string
		contentType string
	}{
		{"/", "web/index.html", "text/html; charset=utf-8"},
		{"/assets/app.css", "web/app.css", "text/css; charset=utf-8"},
		{"/assets/app.js", "web/app.js", "text/javascript; charset=utf-8"},
	} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			t.Run(method+" "+tt.path, func(t *testing.T) {
				f := newFixture(t)
				expected, err := os.ReadFile(tt.file)
				if err != nil {
					t.Fatal(err)
				}
				if len(expected) == 0 || !utf8.Valid(expected) {
					t.Fatal("web asset must be nonempty UTF-8")
				}
				response := request(f.handler, method, tt.path, "")
				if response.Code != http.StatusOK {
					t.Fatalf("status = %d, want 200", response.Code)
				}
				for name, value := range map[string]string{
					"Content-Type":            tt.contentType,
					"Content-Length":          strconv.Itoa(len(expected)),
					"Cache-Control":           "no-store",
					"X-Content-Type-Options":  "nosniff",
					"Content-Security-Policy": policy,
				} {
					if got := response.Header().Get(name); got != value {
						t.Errorf("%s = %q, want %q", name, got, value)
					}
				}
				if method == http.MethodHead {
					if response.Body.Len() != 0 {
						t.Error("HEAD returned a body")
					}
				} else if !bytes.Equal(response.Body.Bytes(), expected) {
					t.Error("response body differs from the embedded source file")
				}
				if f.store.findCalls != 0 || len(f.store.created) != 0 || f.store.updateCalls != 0 {
					t.Error("static file request accessed the store")
				}
				assertLogs(t, f.logs, "", 0)
			})
		}
	}
}

func TestStaticWebMethods(t *testing.T) {
	for _, path := range []string{"/", "/assets/app.css", "/assets/app.js"} {
		for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodOptions} {
			t.Run(method+" "+path, func(t *testing.T) {
				f := newFixture(t)
				response := request(f.handler, method, path, "")
				assertProblem(t, response, http.StatusMethodNotAllowed, detailNotAllowed)
				if allow := response.Header().Get("Allow"); allow != "GET, HEAD" {
					t.Errorf("Allow = %q, want GET, HEAD", allow)
				}
				assertLogs(t, f.logs, "", 0)
			})
		}
	}
}

func TestStaticWebPathsAreExplicit(t *testing.T) {
	for _, path := range []string{
		"/assets",
		"/assets/",
		"/assets/missing.js",
		"/assets/index.html",
		"/assets/app.js/",
		"/assets/app.css.map",
		"/assets/%2e%2e/static.go",
		"/assets/%2e%2e/web/index.html",
		"/web/index.html",
		"/static.go",
		"/index.html",
		"/anything",
	} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodHead} {
			t.Run(method+" "+path, func(t *testing.T) {
				f := newFixture(t)
				response := request(f.handler, method, path, "")
				if method == http.MethodHead {
					if response.Code != http.StatusNotFound || response.Body.Len() != 0 {
						t.Errorf("HEAD response = (%d, %q), want (404, empty)", response.Code, response.Body.String())
					}
					if contentType := response.Header().Get("Content-Type"); contentType != "application/problem+json" {
						t.Errorf("Content-Type = %q, want application/problem+json", contentType)
					}
				} else {
					assertProblem(t, response, http.StatusNotFound, detailNotFound)
				}
				if allow := response.Header().Get("Allow"); allow != "" {
					t.Errorf("unknown path has Allow = %q", allow)
				}
				assertLogs(t, f.logs, "", 0)
			})
		}
	}
}
