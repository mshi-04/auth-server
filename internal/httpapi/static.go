package httpapi

import (
	_ "embed"
	"io"
	"net/http"
	"strconv"
)

//go:embed web/index.html
var indexHTML string

//go:embed web/app.css
var appCSS string

//go:embed web/app.js
var appJS string

const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

func webRoutes() []route {
	return []route{
		{path: "/{$}", handlers: map[string]http.HandlerFunc{http.MethodGet: serveStatic("text/html; charset=utf-8", indexHTML)}},
		{path: "/assets/app.css", handlers: map[string]http.HandlerFunc{http.MethodGet: serveStatic("text/css; charset=utf-8", appCSS)}},
		{path: "/assets/app.js", handlers: map[string]http.HandlerFunc{http.MethodGet: serveStatic("text/javascript; charset=utf-8", appJS)}},
	}
}

func serveStatic(contentType, content string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodHead {
			return
		}
		_, _ = io.WriteString(w, content)
	}
}
