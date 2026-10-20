package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"

	"auth-server/internal/auth"
)

const maxBodyBytes = 16 * 1024

type handler struct {
	service *auth.Service
	logger  *slog.Logger
}

type credentials struct {
	Email    *string `json:"email"`
	Password *string `json:"password"`
}

type route struct {
	path     string
	handlers map[string]http.HandlerFunc
}

func NewHandler(service *auth.Service, logger *slog.Logger) http.Handler {
	h := &handler{service: service, logger: logger}
	mux := http.NewServeMux()
	for _, rt := range []route{
		{path: "/v1/users", handlers: map[string]http.HandlerFunc{http.MethodPost: h.register}},
		{path: "/v1/sessions", handlers: map[string]http.HandlerFunc{http.MethodPost: h.login}},
		{path: "/healthz", handlers: map[string]http.HandlerFunc{http.MethodGet: healthz}},
	} {
		var allowed []string
		for method, handle := range rt.handlers {
			mux.HandleFunc(method+" "+rt.path, handle)
			allowed = append(allowed, method)
			if method == http.MethodGet {
				allowed = append(allowed, http.MethodHead)
			}
		}
		slices.Sort(allowed)
		mux.HandleFunc(rt.path, methodNotAllowed(strings.Join(allowed, ", ")))
	}
	mux.HandleFunc("/", notFound)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// ServeMux は経路を決められない要求（authority 形式の CONNECT など）に、"/" を通さず text/plain の 404 を返す。
		if _, pattern := mux.Handler(r); pattern == "" {
			notFound(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func healthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func notFound(w http.ResponseWriter, r *http.Request) {
	writeProblem(w, r, http.StatusNotFound, "指定されたリソースが見つかりません")
}

func (h *handler) register(w http.ResponseWriter, r *http.Request) {
	input, ok := readCredentials(w, r)
	if !ok {
		return
	}
	userID, err := h.service.Register(r.Context(), *input.Email, *input.Password)
	if err != nil {
		h.writeAuthError(w, r, err)
		return
	}
	writeUserID(w, http.StatusCreated, userID)
}

func (h *handler) login(w http.ResponseWriter, r *http.Request) {
	input, ok := readCredentials(w, r)
	if !ok {
		return
	}
	userID, err := h.service.Login(r.Context(), *input.Email, *input.Password)
	if err != nil {
		h.writeAuthError(w, r, err)
		return
	}
	writeUserID(w, http.StatusOK, userID)
}

func readCredentials(w http.ResponseWriter, r *http.Request) (credentials, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	body, err := io.ReadAll(r.Body)
	var sizeError *http.MaxBytesError
	if errors.As(err, &sizeError) {
		writeProblem(w, r, http.StatusRequestEntityTooLarge, "リクエストボディが上限を超えています")
		return credentials{}, false
	}
	if err != nil {
		writeProblem(w, r, http.StatusBadRequest, "リクエストボディを読み取れませんでした")
		return credentials{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var input credentials
	if err := decoder.Decode(&input); err != nil || input.Email == nil || input.Password == nil {
		writeProblem(w, r, http.StatusBadRequest, "リクエストのJSONが正しくありません")
		return credentials{}, false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeProblem(w, r, http.StatusBadRequest, "リクエストのJSONが正しくありません")
		return credentials{}, false
	}
	return input, true
}

func (h *handler) writeAuthError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, auth.ErrInvalidEmail):
		writeProblem(w, r, http.StatusUnprocessableEntity, "メールアドレスの形式が正しくありません")
	case errors.Is(err, auth.ErrWeakPassword):
		writeProblem(w, r, http.StatusUnprocessableEntity, "パスワードがポリシーを満たしていません")
	case errors.Is(err, auth.ErrEmailTaken):
		writeProblem(w, r, http.StatusConflict, "メールアドレスは既に登録されています")
	case errors.Is(err, auth.ErrInvalidCredentials):
		writeProblem(w, r, http.StatusUnauthorized, "メールアドレスまたはパスワードが正しくありません")
	case errors.Is(err, auth.ErrBusy), errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		writeProblem(w, r, http.StatusServiceUnavailable, "一時的に処理を受け付けられません")
	default:
		h.logger.ErrorContext(r.Context(), "request failed", "error", err)
		writeProblem(w, r, http.StatusInternalServerError, "サーバー内部でエラーが発生しました")
	}
}

func writeUserID(w http.ResponseWriter, status int, userID string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		UserID string `json:"user_id"`
	}{UserID: userID})
}

func writeProblem(w http.ResponseWriter, r *http.Request, status int, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	_ = json.NewEncoder(w).Encode(struct {
		Type   string `json:"type"`
		Title  string `json:"title"`
		Status int    `json:"status"`
		Detail string `json:"detail"`
	}{Type: "about:blank", Title: http.StatusText(status), Status: status, Detail: detail})
}

func methodNotAllowed(allow string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", allow)
		writeProblem(w, r, http.StatusMethodNotAllowed, "指定されたHTTPメソッドは使用できません")
	}
}
