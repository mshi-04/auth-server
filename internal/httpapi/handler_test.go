package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/iotest"

	"auth-server/internal/auth"
	"auth-server/internal/httpapi"
	"auth-server/internal/password"

	"github.com/google/uuid"
)

const testPassword = "correct horse battery staple"

const (
	detailInvalidJSON  = "リクエストのJSONが正しくありません"
	detailReadFailure  = "リクエストボディを読み取れませんでした"
	detailTooLarge     = "リクエストボディが上限を超えています"
	detailInvalidEmail = "メールアドレスの形式が正しくありません"
	detailWeakPassword = "パスワードがポリシーを満たしていません"
	detailEmailTaken   = "メールアドレスは既に登録されています"
	detailUnauthorized = "メールアドレスまたはパスワードが正しくありません"
	detailBusy         = "一時的に処理を受け付けられません"
	detailInternal     = "サーバー内部でエラーが発生しました"
	detailNotFound     = "指定されたリソースが見つかりません"
	detailNotAllowed   = "指定されたHTTPメソッドは使用できません"
)

type fakeUserStore struct {
	credentials map[string]auth.Credential
	created     []auth.NewUser
	findCalls   int
	updateCalls int
	createErr   error
	findErr     error
	updateErr   error
	lastContext context.Context
}

func (s *fakeUserStore) CreateUser(ctx context.Context, user auth.NewUser) error {
	s.lastContext = ctx
	if s.createErr != nil {
		return s.createErr
	}
	if _, exists := s.credentials[user.EmailNormalized]; exists {
		return auth.ErrEmailTaken
	}
	s.created = append(s.created, user)
	s.credentials[user.EmailNormalized] = auth.Credential{UserID: user.ID, PasswordHash: user.PasswordHash}
	return nil
}

func (s *fakeUserStore) FindCredentialByEmail(ctx context.Context, email string) (auth.Credential, error) {
	s.lastContext = ctx
	s.findCalls++
	if s.findErr != nil {
		return auth.Credential{}, s.findErr
	}
	credential, exists := s.credentials[email]
	if !exists {
		return auth.Credential{}, auth.ErrUserNotFound
	}
	return credential, nil
}

func (s *fakeUserStore) UpdatePasswordHash(ctx context.Context, userID, phc string) error {
	s.lastContext = ctx
	s.updateCalls++
	if s.updateErr != nil {
		return s.updateErr
	}
	for email, credential := range s.credentials {
		if credential.UserID == userID {
			credential.PasswordHash = phc
			s.credentials[email] = credential
			return nil
		}
	}
	return auth.ErrUserNotFound
}

type fixture struct {
	handler http.Handler
	store   *fakeUserStore
	hasher  *password.Hasher
	logs    *bytes.Buffer
}

func newFixture(t testing.TB) *fixture {
	t.Helper()
	params := password.DefaultParams()
	params.MemoryKiB = 64
	params.Iterations = 1
	params.Parallelism = 1
	hasher, err := password.New(params)
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeUserStore{credentials: make(map[string]auth.Credential)}
	logs := new(bytes.Buffer)
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	service, err := auth.NewService(store, hasher, logger)
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{handler: httpapi.NewHandler(service, logger), store: store, hasher: hasher, logs: logs}
}

func request(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(method, path, strings.NewReader(body)))
	return recorder
}

func credentialsJSON(t testing.TB, email, rawPassword string) string {
	t.Helper()
	body, err := json.Marshal(map[string]string{"email": email, "password": rawPassword})
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func assertUserID(t testing.TB, response *httptest.ResponseRecorder, status int) string {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d; response = %s", response.Code, status, response.Body)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", contentType)
	}
	var output map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &output); err != nil {
		t.Fatal(err)
	}
	if len(output) != 1 || output["user_id"] == "" {
		t.Fatalf("success response = %v, want only a nonempty user_id", output)
	}
	return output["user_id"]
}

func assertProblem(t testing.TB, response *httptest.ResponseRecorder, status int, detail string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d; response = %s", response.Code, status, response.Body)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "application/problem+json" {
		t.Errorf("Content-Type = %q, want application/problem+json", contentType)
	}
	var problem map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if len(problem) != 4 || problem["type"] != "about:blank" || problem["title"] != http.StatusText(status) || problem["status"] != float64(status) {
		t.Errorf("invalid Problem Details: %v", problem)
	}
	if problem["detail"] != detail {
		t.Errorf("detail = %v, want %q", problem["detail"], detail)
	}
}

func assertLogs(t testing.TB, logs *bytes.Buffer, level string, count int, secrets ...string) {
	t.Helper()
	for _, secret := range secrets {
		if secret != "" && strings.Contains(logs.String(), secret) {
			t.Error("logs contain secret input")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(logs.Bytes()))
	for index := 0; index < count; index++ {
		var record map[string]any
		if err := decoder.Decode(&record); err != nil {
			t.Fatalf("decode log %d: %v", index, err)
		}
		if record["level"] != level {
			t.Errorf("log level = %v, want %s", record["level"], level)
		}
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		t.Fatalf("log count differs from %d", count)
	}
}

func mustPHC(t testing.TB, hasher *password.Hasher, raw string) string {
	t.Helper()
	parsed, err := password.ParsePassword(raw)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := hasher.Rehash(context.Background(), parsed)
	if err != nil {
		t.Fatal(err)
	}
	phc, err := encoded.PHC()
	if err != nil {
		t.Fatal(err)
	}
	return phc
}

func assertStoredPassword(t testing.TB, f *fixture, email, raw string) {
	t.Helper()
	parsed, err := password.ParsePassword(raw)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := password.ParseEncodedHash(f.store.credentials[email].PasswordHash)
	if err != nil {
		t.Fatal(err)
	}
	match, err := f.hasher.Verify(context.Background(), parsed, encoded)
	if err != nil || !match {
		t.Fatalf("stored password verification = (%v, %v), want (true, nil)", match, err)
	}
}

func TestRegistrationAndLogin(t *testing.T) {
	f := newFixture(t)
	body := credentialsJSON(t, "User@Example.com", testPassword)
	response := request(f.handler, http.MethodPost, "/v1/users", body)
	userID := assertUserID(t, response, http.StatusCreated)
	id, err := uuid.Parse(userID)
	if err != nil || id.Version() != 4 {
		t.Errorf("user_id is not a UUID v4")
	}
	if len(f.store.created) != 1 || f.store.created[0].Email != "User@Example.com" || f.store.created[0].EmailNormalized != "user@example.com" {
		t.Fatal("registration did not preserve the address and normalize its lookup key")
	}
	assertStoredPassword(t, f, "user@example.com", testPassword)
	response = request(f.handler, http.MethodPost, "/v1/sessions", credentialsJSON(t, "USER@example.COM", testPassword))
	if got := assertUserID(t, response, http.StatusOK); got != userID {
		t.Errorf("login user_id = %q, want registered user_id", got)
	}
	assertProblem(t, request(f.handler, http.MethodPost, "/v1/users", body), http.StatusConflict, detailEmailTaken)
	assertLogs(t, f.logs, "", 0, testPassword, f.store.created[0].PasswordHash, body)
}

func TestInputValidation(t *testing.T) {
	for _, path := range []string{"/v1/users", "/v1/sessions"} {
		t.Run(path, func(t *testing.T) {
			for _, tt := range []struct {
				name string
				body string
			}{
				{"empty", ""},
				{"whitespace", " \n\t"},
				{"malformed", `{"email":"user@example.com","password":"input-secret",}`},
				{"null", `null`},
				{"array", `[]`},
				{"string", `"input-secret"`},
				{"number", `12`},
				{"boolean", `false`},
				{"missing both", `{}`},
				{"missing email", `{"password":"input-secret"}`},
				{"missing password", `{"email":"user@example.com"}`},
				{"null email", `{"email":null,"password":"input-secret"}`},
				{"null password", `{"email":"user@example.com","password":null}`},
				{"number email", `{"email":1,"password":"input-secret"}`},
				{"boolean password", `{"email":"user@example.com","password":true}`},
				{"object password", `{"email":"user@example.com","password":{}}`},
				{"array password", `{"email":"user@example.com","password":[]}`},
				{"unknown field", `{"email":"user@example.com","password":"input-secret","input-secret":1}`},
				{"second object", `{"email":"user@example.com","password":"input-secret"} {}`},
				{"trailing null", `{"email":"user@example.com","password":"input-secret"} null`},
				{"trailing garbage", `{"email":"user@example.com","password":"input-secret"} input-secret`},
			} {
				t.Run(tt.name, func(t *testing.T) {
					f := newFixture(t)
					response := request(f.handler, http.MethodPost, path, tt.body)
					assertProblem(t, response, http.StatusBadRequest, detailInvalidJSON)
					if len(f.store.created) != 0 || f.store.findCalls != 0 {
						t.Error("invalid HTTP input reached the store")
					}
					if strings.Contains(response.Body.String(), "input-secret") {
						t.Error("response contains input data")
					}
					assertLogs(t, f.logs, "", 0, "input-secret", tt.body)
				})
			}
		})
	}
}

func TestEmptyStringsReachAuth(t *testing.T) {
	for _, tt := range []struct {
		name     string
		path     string
		email    string
		password string
		status   int
		detail   string
	}{
		{"registration email", "/v1/users", "", testPassword, http.StatusUnprocessableEntity, detailInvalidEmail},
		{"registration password", "/v1/users", "user@example.com", "", http.StatusUnprocessableEntity, detailWeakPassword},
		{"login email", "/v1/sessions", "", testPassword, http.StatusUnauthorized, detailUnauthorized},
		{"login password", "/v1/sessions", "user@example.com", "", http.StatusUnauthorized, detailUnauthorized},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			response := request(f.handler, http.MethodPost, tt.path, credentialsJSON(t, tt.email, tt.password))
			assertProblem(t, response, tt.status, tt.detail)
			assertLogs(t, f.logs, "", 0)
		})
	}
}

func TestBodyLimit(t *testing.T) {
	body := credentialsJSON(t, "user@example.com", testPassword)
	for _, path := range []string{"/v1/users", "/v1/sessions"} {
		for _, tt := range []struct {
			name   string
			body   string
			status int
		}{
			{"exact limit", body + strings.Repeat(" ", 16*1024-len(body)), http.StatusCreated},
			{"excess trailing whitespace", body + strings.Repeat(" ", 16*1024+1-len(body)), http.StatusRequestEntityTooLarge},
			{"malformed excess", strings.Repeat("x", 16*1024+1), http.StatusRequestEntityTooLarge},
		} {
			t.Run(path+"/"+tt.name, func(t *testing.T) {
				f := newFixture(t)
				response := request(f.handler, http.MethodPost, path, tt.body)
				if tt.status == http.StatusCreated && path == "/v1/sessions" {
					assertProblem(t, response, http.StatusUnauthorized, detailUnauthorized)
				} else if tt.status == http.StatusCreated {
					assertUserID(t, response, http.StatusCreated)
				} else {
					assertProblem(t, response, tt.status, detailTooLarge)
					if len(f.store.created) != 0 || f.store.findCalls != 0 {
						t.Error("oversized input reached the store")
					}
				}
				assertLogs(t, f.logs, "", 0)
			})
		}
	}
}

func TestJSONCompatibility(t *testing.T) {
	for _, tt := range []struct {
		name     string
		body     string
		password string
	}{
		{"case insensitive", `{"EMAIL":"user@example.com","PaSsWoRd":"` + testPassword + `"}`, testPassword},
		{"duplicate last wins", `{"email":"ignored@example.com","email":"user@example.com","password":"ignored-password","password":"` + testPassword + `"}`, testPassword},
		{"escaped key", `{"e\u006dail":"user@example.com","password":"` + testPassword + `"}`, testPassword},
		{"raw invalid UTF8", "{\"email\":\"user@example.com\",\"password\":\"prefix-value-" + string([]byte{0xff}) + "\"}", "prefix-value-\ufffd"},
		{"unpaired high surrogate", `{"email":"user@example.com","password":"prefix-value-\ud800"}`, "prefix-value-\ufffd"},
		{"unpaired low surrogate", `{"email":"user@example.com","password":"prefix-value-\udfff"}`, "prefix-value-\ufffd"},
		{"paired surrogate", `{"email":"user@example.com","password":"prefix-value-\ud83d\ude00"}`, "prefix-value-😀"},
		{"trailing whitespace", credentialsJSON(t, "user@example.com", testPassword) + " \t\r\n", testPassword},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			req := httptest.NewRequest(http.MethodPost, "/v1/users", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "text/plain")
			response := httptest.NewRecorder()
			f.handler.ServeHTTP(response, req)
			assertUserID(t, response, http.StatusCreated)
			assertStoredPassword(t, f, "user@example.com", tt.password)
			assertLogs(t, f.logs, "", 0, tt.password)
		})
	}
}

func TestLegacyEmptyPassword(t *testing.T) {
	f := newFixture(t)
	params := password.DefaultParams()
	params.MemoryKiB = 32
	params.Iterations = 1
	params.Parallelism = 1
	oldHasher, err := password.New(params)
	if err != nil {
		t.Fatal(err)
	}
	oldPHC := mustPHC(t, oldHasher, "")
	f.store.credentials["user@example.com"] = auth.Credential{UserID: "legacy-user", PasswordHash: oldPHC}
	response := request(f.handler, http.MethodPost, "/v1/sessions", credentialsJSON(t, "user@example.com", ""))
	if userID := assertUserID(t, response, http.StatusOK); userID != "legacy-user" {
		t.Errorf("user_id = %q, want legacy-user", userID)
	}
	if f.store.updateCalls != 1 || f.store.credentials["user@example.com"].PasswordHash == oldPHC {
		t.Error("empty legacy password was not rehashed")
	}
	assertStoredPassword(t, f, "user@example.com", "")
	assertLogs(t, f.logs, "", 0, oldPHC)
}

func TestRouting(t *testing.T) {
	for _, tt := range []struct {
		method string
		path   string
		status int
		allow  string
	}{
		{http.MethodGet, "/healthz", http.StatusOK, ""},
		{http.MethodHead, "/healthz", http.StatusOK, ""},
		{http.MethodPost, "/healthz", http.StatusMethodNotAllowed, "GET, HEAD"},
		{http.MethodOptions, "/healthz", http.StatusMethodNotAllowed, "GET, HEAD"},
		{http.MethodGet, "/v1/users", http.StatusMethodNotAllowed, "POST"},
		{http.MethodHead, "/v1/users", http.StatusMethodNotAllowed, "POST"},
		{http.MethodDelete, "/v1/sessions", http.StatusMethodNotAllowed, "POST"},
		{http.MethodGet, "/missing", http.StatusNotFound, ""},
		{http.MethodPost, "/missing", http.StatusNotFound, ""},
		{http.MethodHead, "/missing", http.StatusNotFound, ""},
		{http.MethodGet, "/healthz/", http.StatusNotFound, ""},
		{http.MethodConnect, "example.com:443", http.StatusNotFound, ""},
	} {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			f := newFixture(t)
			f.store.findErr = errors.New("health must not query the store")
			response := request(f.handler, tt.method, tt.path, "")
			if tt.status == http.StatusOK || tt.method == http.MethodHead {
				if response.Code != tt.status || response.Body.Len() != 0 {
					t.Errorf("response = (%d, %q), want (%d, empty)", response.Code, response.Body.String(), tt.status)
				}
				if tt.status != http.StatusOK && response.Header().Get("Content-Type") != "application/problem+json" {
					t.Error("HEAD error did not advertise Problem Details")
				}
			} else if tt.status == http.StatusMethodNotAllowed {
				assertProblem(t, response, tt.status, detailNotAllowed)
			} else {
				assertProblem(t, response, tt.status, detailNotFound)
			}
			if allow := response.Header().Get("Allow"); allow != tt.allow {
				t.Errorf("Allow = %q, want %q", allow, tt.allow)
			}
			if f.store.findCalls != 0 || len(f.store.created) != 0 {
				t.Error("routing or health check called the store")
			}
			assertLogs(t, f.logs, "", 0)
		})
	}
}

func TestAuthErrorResponses(t *testing.T) {
	for _, tt := range []struct {
		name       string
		path       string
		email      string
		password   string
		storeError error
		status     int
		detail     string
		logCount   int
	}{
		{"invalid registration email", "/v1/users", "invalid", testPassword, nil, http.StatusUnprocessableEntity, detailInvalidEmail, 0},
		{"weak password", "/v1/users", "user@example.com", "short", nil, http.StatusUnprocessableEntity, detailWeakPassword, 0},
		{"registration maximum length", "/v1/users", "user@example.com", strings.Repeat("x", 129), nil, http.StatusUnprocessableEntity, detailWeakPassword, 0},
		{"wrapped email taken", "/v1/users", "user@example.com", testPassword, fmt.Errorf("wrapped: %w", auth.ErrEmailTaken), http.StatusConflict, detailEmailTaken, 0},
		{"wrapped registration busy", "/v1/users", "user@example.com", testPassword, fmt.Errorf("wrapped: %w", auth.ErrBusy), http.StatusServiceUnavailable, detailBusy, 0},
		{"registration canceled", "/v1/users", "user@example.com", testPassword, fmt.Errorf("insert user: %w", context.Canceled), http.StatusServiceUnavailable, detailBusy, 0},
		{"invalid login email", "/v1/sessions", "invalid", testPassword, nil, http.StatusUnauthorized, detailUnauthorized, 0},
		{"missing user", "/v1/sessions", "missing@example.com", testPassword, nil, http.StatusUnauthorized, detailUnauthorized, 0},
		{"wrong password", "/v1/sessions", "user@example.com", "incorrect-password", nil, http.StatusUnauthorized, detailUnauthorized, 0},
		{"login maximum length", "/v1/sessions", "user@example.com", strings.Repeat("x", 129), nil, http.StatusUnauthorized, detailUnauthorized, 0},
		{"wrapped login busy", "/v1/sessions", "user@example.com", testPassword, fmt.Errorf("wrapped: %w", auth.ErrBusy), http.StatusServiceUnavailable, detailBusy, 0},
		{"login deadline", "/v1/sessions", "user@example.com", testPassword, fmt.Errorf("find password credential: %w", context.DeadlineExceeded), http.StatusServiceUnavailable, detailBusy, 0},
		{"registration unexpected", "/v1/users", "user@example.com", testPassword, errors.New("database failure detail"), http.StatusInternalServerError, detailInternal, 1},
		{"login unexpected", "/v1/sessions", "user@example.com", testPassword, errors.New("database failure detail"), http.StatusInternalServerError, detailInternal, 1},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			phc := mustPHC(t, f.hasher, testPassword)
			if tt.path == "/v1/users" {
				f.store.createErr = tt.storeError
			} else {
				f.store.findErr = tt.storeError
				f.store.credentials["user@example.com"] = auth.Credential{UserID: "existing-user", PasswordHash: phc}
			}
			body := credentialsJSON(t, tt.email, tt.password)
			response := request(f.handler, http.MethodPost, tt.path, body)
			assertProblem(t, response, tt.status, tt.detail)
			if challenge := response.Header().Get("WWW-Authenticate"); challenge != "" {
				t.Errorf("WWW-Authenticate = %q, want none", challenge)
			}
			for _, secret := range []string{tt.password, phc, body, "database failure detail"} {
				if strings.Contains(response.Body.String(), secret) {
					t.Error("error response contains input or internal error data")
				}
			}
			assertLogs(t, f.logs, "ERROR", tt.logCount, tt.password, phc, body)
		})
	}
}

func TestAuthLogsAreNotDuplicated(t *testing.T) {
	for _, tt := range []struct {
		name   string
		broken bool
		status int
		level  string
	}{
		{"invalid stored hash", true, http.StatusUnauthorized, "ERROR"},
		{"rehash storage failure", false, http.StatusOK, "WARN"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			phc := "invalid-secret-hash"
			if !tt.broken {
				phc = mustPHC(t, f.hasher, testPassword)
				phc = strings.Replace(phc, "m=64,t=1,p=1", "p=1,t=1,m=64", 1)
				f.store.updateErr = errors.New("write failed")
			}
			f.store.credentials["user@example.com"] = auth.Credential{UserID: "existing-user", PasswordHash: phc}
			response := request(f.handler, http.MethodPost, "/v1/sessions", credentialsJSON(t, "user@example.com", testPassword))
			if tt.status == http.StatusOK {
				if userID := assertUserID(t, response, tt.status); userID != "existing-user" {
					t.Errorf("user_id = %q, want existing-user", userID)
				}
			} else {
				assertProblem(t, response, tt.status, detailUnauthorized)
			}
			assertLogs(t, f.logs, tt.level, 1, testPassword, phc)
		})
	}
}

func TestRequestContextPropagation(t *testing.T) {
	type contextKey struct{}
	for _, path := range []string{"/v1/users", "/v1/sessions"} {
		t.Run(path, func(t *testing.T) {
			f := newFixture(t)
			ctx := context.WithValue(context.Background(), contextKey{}, "request marker")
			req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(credentialsJSON(t, "user@example.com", testPassword))).WithContext(ctx)
			f.handler.ServeHTTP(httptest.NewRecorder(), req)
			if f.store.lastContext != ctx {
				t.Error("request context was not passed through auth to the store")
			}
		})
	}
}

func TestBodyReadFailure(t *testing.T) {
	for _, path := range []string{"/v1/users", "/v1/sessions"} {
		t.Run(path, func(t *testing.T) {
			f := newFixture(t)
			response := httptest.NewRecorder()
			f.handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, iotest.ErrReader(errors.New("connection reset"))))
			assertProblem(t, response, http.StatusBadRequest, detailReadFailure)
			if len(f.store.created) != 0 || f.store.findCalls != 0 {
				t.Error("unreadable body reached the store")
			}
			assertLogs(t, f.logs, "", 0)
		})
	}
}

func TestUncleanPathsRedirect(t *testing.T) {
	for _, tt := range []struct {
		method   string
		path     string
		location string
	}{
		{http.MethodGet, "//healthz", "/healthz"},
		{http.MethodPost, "/v1//users", "/v1/users"},
	} {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			f := newFixture(t)
			response := request(f.handler, tt.method, tt.path, credentialsJSON(t, "user@example.com", testPassword))
			if response.Code != http.StatusTemporaryRedirect || response.Header().Get("Location") != tt.location {
				t.Errorf("response = (%d, Location %q), want (307, %q)", response.Code, response.Header().Get("Location"), tt.location)
			}
			if len(f.store.created) != 0 || f.store.findCalls != 0 {
				t.Error("redirected request reached the store")
			}
		})
	}
}
