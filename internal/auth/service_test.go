package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"auth-server/internal/password"

	"github.com/google/uuid"
)

const testPassword = "correct horse battery staple"

type hashUpdate struct {
	userID string
	phc    string
}

type fakeUserStore struct {
	credentials map[string]Credential
	created     []NewUser
	found       []string
	updated     []hashUpdate
	contexts    []context.Context
	createErr   error
	findErr     error
	updateErr   error
}

func (s *fakeUserStore) CreateUser(ctx context.Context, u NewUser) error {
	s.contexts = append(s.contexts, ctx)
	s.created = append(s.created, u)
	if s.createErr != nil {
		return s.createErr
	}
	if _, exists := s.credentials[u.EmailNormalized]; exists {
		return ErrEmailTaken
	}
	if s.credentials == nil {
		s.credentials = make(map[string]Credential)
	}
	s.credentials[u.EmailNormalized] = Credential{UserID: u.ID, PasswordHash: u.PasswordHash}
	return nil
}

func (s *fakeUserStore) FindCredentialByEmail(ctx context.Context, emailNormalized string) (Credential, error) {
	s.contexts = append(s.contexts, ctx)
	s.found = append(s.found, emailNormalized)
	if s.findErr != nil {
		return Credential{}, s.findErr
	}
	credential, exists := s.credentials[emailNormalized]
	if !exists {
		return Credential{}, ErrUserNotFound
	}
	return credential, nil
}

func (s *fakeUserStore) UpdatePasswordHash(ctx context.Context, userID, phc string) error {
	s.contexts = append(s.contexts, ctx)
	s.updated = append(s.updated, hashUpdate{userID: userID, phc: phc})
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
	return ErrUserNotFound
}

func smallParams() password.Params {
	params := password.DefaultParams()
	params.MemoryKiB = 64
	params.Iterations = 1
	params.Parallelism = 1
	return params
}

func mustHasher(t testing.TB, params password.Params) *password.Hasher {
	t.Helper()
	hasher, err := password.New(params)
	if err != nil {
		t.Fatalf("password.New() error = %v", err)
	}
	return hasher
}

func mustPassword(t testing.TB, raw string) password.Password {
	t.Helper()
	parsed, err := password.ParsePassword(raw)
	if err != nil {
		t.Fatalf("ParsePassword() error = %v", err)
	}
	return parsed
}

func mustPHC(t testing.TB, hasher *password.Hasher, raw string) string {
	t.Helper()
	encoded, err := hasher.Rehash(context.Background(), mustPassword(t, raw))
	if err != nil {
		t.Fatalf("Rehash() error = %v", err)
	}
	phc, err := encoded.PHC()
	if err != nil {
		t.Fatalf("PHC() error = %v", err)
	}
	return phc
}

func legacyPHC(t testing.TB, raw string) string {
	t.Helper()
	params := smallParams()
	params.MemoryKiB = 32
	return mustPHC(t, mustHasher(t, params), raw)
}

func noncanonicalPHC(t testing.TB, raw string) string {
	t.Helper()
	return strings.Replace(mustPHC(t, mustHasher(t, smallParams()), raw), "m=64,t=1,p=1", "p=1,m=64,t=1", 1)
}

func mustService(t testing.TB, store UserStore, hasher *password.Hasher) (*Service, *bytes.Buffer) {
	t.Helper()
	var logs bytes.Buffer
	service, err := NewService(store, hasher, slog.New(slog.NewJSONHandler(&logs, nil)))
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service, &logs
}

func assertLogs(t testing.TB, logs *bytes.Buffer, level string, count int, secrets ...string) {
	t.Helper()
	output := logs.String()
	for _, secret := range secrets {
		if secret != "" && strings.Contains(output, secret) {
			t.Error("log output contains a secret")
		}
	}
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if output == "" {
		lines = nil
	}
	if len(lines) != count {
		t.Fatalf("log count = %d, want %d", len(lines), count)
	}
	for _, line := range lines {
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode log record: %v", err)
		}
		if record["level"] != level {
			t.Errorf("log level = %v, want %s", record["level"], level)
		}
	}
}

func TestNewService(t *testing.T) {
	hasher := mustHasher(t, smallParams())
	store := &fakeUserStore{}
	logger := slog.New(slog.DiscardHandler)
	for _, tt := range []struct {
		name   string
		store  UserStore
		hasher *password.Hasher
		logger *slog.Logger
		want   error
	}{
		{name: "nil store", hasher: hasher, logger: logger},
		{name: "nil hasher", store: store, logger: logger},
		{name: "nil logger", store: store, hasher: hasher},
		{name: "zero hasher", store: store, hasher: &password.Hasher{}, logger: logger, want: password.ErrInvalidParams},
	} {
		t.Run(tt.name, func(t *testing.T) {
			service, err := NewService(tt.store, tt.hasher, tt.logger)
			if service != nil || err == nil {
				t.Fatalf("NewService() returned service = %t, error = %v", service != nil, err)
			}
			if tt.want != nil && !errors.Is(err, tt.want) {
				t.Errorf("NewService() error = %v, want %v", err, tt.want)
			}
		})
	}
	service, _ := mustService(t, store, hasher)
	if _, err := service.dummyHash.PHC(); err != nil {
		t.Fatalf("dummy PHC() error = %v", err)
	}
	if hasher.NeedsRehash(service.dummyHash) {
		t.Error("dummy hash does not use current parameters")
	}
	if len(store.contexts) != 0 {
		t.Error("constructor accessed the store")
	}
}

func TestRegisterAndLogin(t *testing.T) {
	for _, tt := range []struct {
		name     string
		input    string
		verifyAs string
	}{
		{name: "minimum", input: strings.Repeat("a", 12), verifyAs: strings.Repeat("a", 12)},
		{name: "maximum", input: strings.Repeat("a", 128), verifyAs: strings.Repeat("a", 128)},
		{name: "unicode code points", input: strings.Repeat("界", 12), verifyAs: strings.Repeat("界", 12)},
		{name: "NFKC", input: "ａｂｃｄｅｆｇｈｉｊｋｌ", verifyAs: "abcdefghijkl"},
		{name: "NFKC expansion", input: strings.Repeat("㍿", 3), verifyAs: strings.Repeat("株式会社", 3)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeUserStore{}
			hasher := mustHasher(t, smallParams())
			service, logs := mustService(t, store, hasher)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			userID, err := service.Register(ctx, "Person@EXAMPLE.COM", tt.input)
			if err != nil || userID == "" {
				t.Fatalf("Register() user ID present = %t, error = %v", userID != "", err)
			}
			id, err := uuid.Parse(userID)
			if err != nil || id.Version() != 4 || id.Variant() != uuid.RFC4122 {
				t.Fatalf("registered user ID is not a UUID v4: %v", err)
			}
			if len(store.created) != 1 {
				t.Fatalf("CreateUser() calls = %d, want 1", len(store.created))
			}
			created := store.created[0]
			if created.ID != userID || created.Email != "Person@EXAMPLE.COM" || created.EmailNormalized != "person@example.com" {
				t.Error("registration did not preserve the original email and normalize the lookup address")
			}
			if created.PasswordHash == tt.input || !strings.HasPrefix(created.PasswordHash, "$argon2id$") {
				t.Error("registration did not store a PHC hash")
			}
			loginID, err := service.Login(ctx, "PERSON@example.com", tt.verifyAs)
			if err != nil || loginID != userID {
				t.Fatalf("Login() returned matching ID = %t, error = %v", loginID == userID, err)
			}
			if len(store.found) != 1 || store.found[0] != "person@example.com" || len(store.updated) != 0 {
				t.Error("login did not use the normalized address or unnecessarily rehashed")
			}
			for _, passed := range store.contexts {
				if passed != ctx {
					t.Error("store did not receive the request context")
				}
			}
			assertLogs(t, logs, "", 0)
		})
	}
}

func TestRegisterRejectsInvalidInput(t *testing.T) {
	for _, tt := range []struct {
		name     string
		email    string
		password string
		want     error
	}{
		{name: "empty email", password: testPassword, want: ErrInvalidEmail},
		{name: "invalid email", email: "invalid", password: testPassword, want: ErrInvalidEmail},
		{name: "display name", email: "Person <person@example.com>", password: testPassword, want: ErrInvalidEmail},
		{name: "address list", email: "a@example.com,b@example.com", password: testPassword, want: ErrInvalidEmail},
		{name: "non-ASCII", email: "üser@example.com", password: testPassword, want: ErrInvalidEmail},
		{name: "group syntax", email: "Group: a@example.com;", password: testPassword, want: ErrInvalidEmail},
		{name: "comment", email: "a@example.com ()", password: testPassword, want: ErrInvalidEmail},
		{name: "quoted local part", email: `"a b"@example.com`, password: testPassword, want: ErrInvalidEmail},
		{name: "trailing text", email: "a@example.com extra", password: testPassword, want: ErrInvalidEmail},
		{name: "empty password", email: "a@example.com", want: ErrWeakPassword},
		{name: "short password", email: "a@example.com", password: strings.Repeat("a", 11), want: ErrWeakPassword},
		{name: "long password", email: "a@example.com", password: strings.Repeat("a", 129), want: ErrWeakPassword},
		{name: "invalid UTF8", email: "a@example.com", password: "invalid\xffpassword", want: ErrWeakPassword},
		{name: "long after NFKC", email: "a@example.com", password: strings.Repeat("㍿", 33), want: ErrWeakPassword},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeUserStore{}
			service, logs := mustService(t, store, mustHasher(t, smallParams()))
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			id, err := service.Register(ctx, tt.email, tt.password)
			if id != "" || !errors.Is(err, tt.want) {
				t.Fatalf("Register() ID present = %t, error = %v, want %v", id != "", err, tt.want)
			}
			if len(store.contexts) != 0 {
				t.Error("invalid registration accessed the store")
			}
			assertLogs(t, logs, "", 0)
		})
	}
}

func TestRegisterStoresParsedAddress(t *testing.T) {
	for _, input := range []string{"<Person@EXAMPLE.COM>", "  Person@EXAMPLE.COM  ", " <Person@EXAMPLE.COM> "} {
		t.Run(input, func(t *testing.T) {
			store := &fakeUserStore{}
			service, _ := mustService(t, store, mustHasher(t, smallParams()))
			if _, err := service.Register(context.Background(), input, testPassword); err != nil {
				t.Fatal(err)
			}
			if created := store.created[0]; created.Email != "Person@EXAMPLE.COM" || created.EmailNormalized != "person@example.com" {
				t.Errorf("stored email = %q / %q, want parsed address", created.Email, created.EmailNormalized)
			}
		})
	}
}

func TestRegisterSurfacesHasherProgrammingErrors(t *testing.T) {
	store := &fakeUserStore{}
	service, logs := mustService(t, store, mustHasher(t, smallParams()))
	service.hasher = &password.Hasher{}
	id, err := service.Register(context.Background(), "a@example.com", testPassword)
	if id != "" || !errors.Is(err, password.ErrInvalidParams) || errors.Is(err, ErrWeakPassword) || errors.Is(err, ErrBusy) {
		t.Fatalf("Register() ID present = %t, error = %v, want ErrInvalidParams only", id != "", err)
	}
	if len(store.contexts) != 0 {
		t.Error("failed registration hash accessed the store")
	}
	assertLogs(t, logs, "", 0)
}

func TestRegisterStoreErrors(t *testing.T) {
	unexpected := errors.New("storage failure")
	for _, want := range []error{ErrEmailTaken, ErrBusy, unexpected} {
		t.Run(want.Error(), func(t *testing.T) {
			store := &fakeUserStore{createErr: fmt.Errorf("create: %w", want)}
			service, logs := mustService(t, store, mustHasher(t, smallParams()))
			id, err := service.Register(context.Background(), "a@example.com", testPassword)
			if id != "" || !errors.Is(err, want) {
				t.Fatalf("Register() ID present = %t, error = %v, want %v", id != "", err, want)
			}
			assertLogs(t, logs, "", 0)
		})
	}
	store := &fakeUserStore{}
	service, _ := mustService(t, store, mustHasher(t, smallParams()))
	if _, err := service.Register(context.Background(), "Person@example.com", testPassword); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Register(context.Background(), "PERSON@EXAMPLE.COM", testPassword); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("duplicate normalized email: error = %v, want ErrEmailTaken", err)
	}
}

func TestRegisterHashBusyPreservesContext(t *testing.T) {
	for _, tt := range []struct {
		name string
		ctx  func() (context.Context, context.CancelFunc)
		want error
	}{
		{name: "canceled", ctx: func() (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			return ctx, cancel
		}, want: context.Canceled},
		{name: "deadline", ctx: func() (context.Context, context.CancelFunc) {
			return context.WithTimeout(context.Background(), 0)
		}, want: context.DeadlineExceeded},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeUserStore{}
			service, logs := mustService(t, store, mustHasher(t, smallParams()))
			ctx, cancel := tt.ctx()
			defer cancel()
			id, err := service.Register(ctx, "a@example.com", testPassword)
			if id != "" || !errors.Is(err, ErrBusy) || !errors.Is(err, tt.want) {
				t.Fatalf("Register() ID present = %t, error = %v, want ErrBusy and %v", id != "", err, tt.want)
			}
			if len(store.contexts) != 0 {
				t.Error("failed registration hash accessed the store")
			}
			assertLogs(t, logs, "", 0)
		})
	}
}

func TestLoginUnifiesInvalidCredentials(t *testing.T) {
	hasher := mustHasher(t, smallParams())
	phc := mustPHC(t, hasher, testPassword)
	for _, tt := range []struct {
		name       string
		email      string
		password   string
		credential Credential
		findErr    error
		lookups    int
		errors     int
	}{
		{name: "invalid email", email: "invalid", password: testPassword},
		{name: "display name", email: "Person <a@example.com>", password: testPassword},
		{name: "non-ASCII email", email: "üser@example.com", password: testPassword},
		{name: "missing user", email: "a@example.com", password: testPassword, findErr: fmt.Errorf("lookup: %w", ErrUserNotFound), lookups: 1},
		{name: "wrong password", email: "a@example.com", password: "incorrect password", credential: Credential{UserID: "user-1", PasswordHash: phc}, lookups: 1},
		{name: "malformed PHC", email: "a@example.com", password: testPassword, credential: Credential{UserID: "user-1", PasswordHash: "malformed-secret-phc"}, lookups: 1, errors: 1},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeUserStore{credentials: map[string]Credential{"a@example.com": tt.credential}, findErr: tt.findErr}
			service, logs := mustService(t, store, hasher)
			id, err := service.Login(context.Background(), tt.email, tt.password)
			if id != "" || !errors.Is(err, ErrInvalidCredentials) || errors.Is(err, ErrUserNotFound) || errors.Is(err, password.ErrInvalidHash) {
				t.Fatalf("Login() ID present = %t, error = %v, want only ErrInvalidCredentials", id != "", err)
			}
			if len(store.found) != tt.lookups || len(store.updated) != 0 {
				t.Errorf("lookup/update calls = %d/%d, want %d/0", len(store.found), len(store.updated), tt.lookups)
			}
			assertLogs(t, logs, "ERROR", tt.errors, tt.password, tt.credential.PasswordHash)
		})
	}
}

func TestLoginDummyVerificationCanceled(t *testing.T) {
	for _, tt := range []struct {
		name       string
		email      string
		credential Credential
		findErr    error
		lookups    int
		errors     int
	}{
		{name: "invalid email", email: "invalid"},
		{name: "missing user", email: "a@example.com", findErr: ErrUserNotFound, lookups: 1},
		{name: "malformed PHC", email: "a@example.com", credential: Credential{UserID: "user-1", PasswordHash: "malformed-secret-phc"}, lookups: 1, errors: 1},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeUserStore{credentials: map[string]Credential{"a@example.com": tt.credential}, findErr: tt.findErr}
			service, logs := mustService(t, store, mustHasher(t, smallParams()))
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			id, err := service.Login(ctx, tt.email, testPassword)
			if id != "" || !errors.Is(err, ErrBusy) || !errors.Is(err, context.Canceled) || errors.Is(err, ErrInvalidCredentials) {
				t.Fatalf("dummy Verify did not propagate cancellation: ID present = %t, error = %v", id != "", err)
			}
			if len(store.found) != tt.lookups || len(store.updated) != 0 {
				t.Errorf("lookup/update calls = %d/%d, want %d/0", len(store.found), len(store.updated), tt.lookups)
			}
			assertLogs(t, logs, "ERROR", tt.errors, testPassword, tt.credential.PasswordHash)
		})
	}
}

func TestLoginRejectsUnparseablePasswordsBeforeLookup(t *testing.T) {
	for _, raw := range []string{strings.Repeat("a", 129), "invalid\xffpassword", strings.Repeat("㍿", 33)} {
		t.Run(fmt.Sprintf("bytes=%d", len(raw)), func(t *testing.T) {
			store := &fakeUserStore{}
			service, logs := mustService(t, store, mustHasher(t, smallParams()))
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			id, err := service.Login(ctx, "a@example.com", raw)
			if id != "" || !errors.Is(err, ErrInvalidCredentials) || errors.Is(err, ErrBusy) {
				t.Fatalf("Login() ID present = %t, error = %v, want ErrInvalidCredentials", id != "", err)
			}
			if len(store.contexts) != 0 {
				t.Error("unparseable password accessed the store")
			}
			assertLogs(t, logs, "", 0)
		})
	}
}

func TestLoginRehashesLegacyCredentials(t *testing.T) {
	for _, tt := range []struct {
		name     string
		password string
		phc      func(testing.TB, string) string
	}{
		{name: "old parameters", password: testPassword, phc: legacyPHC},
		{name: "noncanonical parameters", password: testPassword, phc: noncanonicalPHC},
		{name: "short legacy password", password: "short", phc: legacyPHC},
		{name: "empty legacy password", phc: legacyPHC},
	} {
		t.Run(tt.name, func(t *testing.T) {
			oldPHC := tt.phc(t, tt.password)
			store := &fakeUserStore{credentials: map[string]Credential{
				"a@example.com": {UserID: "user-1", PasswordHash: oldPHC},
			}}
			hasher := mustHasher(t, smallParams())
			service, logs := mustService(t, store, hasher)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			id, err := service.Login(ctx, "a@example.com", tt.password)
			if id != "user-1" || err != nil {
				t.Fatalf("Login() ID = %q, error = %v", id, err)
			}
			if len(store.updated) != 1 || store.updated[0].userID != "user-1" {
				t.Fatalf("UpdatePasswordHash() calls = %d, want one matching user", len(store.updated))
			}
			encoded, err := password.ParseEncodedHash(store.updated[0].phc)
			if err != nil || hasher.NeedsRehash(encoded) {
				t.Fatalf("new hash does not use current canonical parameters: %v", err)
			}
			if ok, err := hasher.Verify(ctx, mustPassword(t, tt.password), encoded); err != nil || !ok {
				t.Fatalf("rehashed credential match = %t, error = %v", ok, err)
			}
			for _, passed := range store.contexts {
				if passed != ctx {
					t.Error("rehash store operation did not receive request context")
				}
			}
			assertLogs(t, logs, "", 0)
		})
	}
}

func TestLoginDoesNotRehashLegacyCredentialOnWrongPassword(t *testing.T) {
	oldPHC := legacyPHC(t, testPassword)
	store := &fakeUserStore{credentials: map[string]Credential{
		"a@example.com": {UserID: "user-1", PasswordHash: oldPHC},
	}}
	service, logs := mustService(t, store, mustHasher(t, smallParams()))
	id, err := service.Login(context.Background(), "a@example.com", "incorrect password")
	if id != "" || !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("Login() ID present = %t, error = %v, want ErrInvalidCredentials", id != "", err)
	}
	if len(store.updated) != 0 || store.credentials["a@example.com"].PasswordHash != oldPHC {
		t.Error("wrong password rehashed or changed the legacy credential")
	}
	assertLogs(t, logs, "", 0)
}

func TestLoginSucceedsAfterRehashSaveFailure(t *testing.T) {
	for _, failure := range []error{
		errors.New("save failure"), ErrUserNotFound, fmt.Errorf("%w: %w", ErrBusy, context.Canceled),
	} {
		t.Run(failure.Error(), func(t *testing.T) {
			oldPHC := legacyPHC(t, testPassword)
			store := &fakeUserStore{
				credentials: map[string]Credential{"a@example.com": {UserID: "user-1", PasswordHash: oldPHC}},
				updateErr:   failure,
			}
			service, logs := mustService(t, store, mustHasher(t, smallParams()))
			id, err := service.Login(context.Background(), "a@example.com", testPassword)
			if id != "user-1" || err != nil {
				t.Fatalf("Login() after save failure: ID = %q, error = %v", id, err)
			}
			if len(store.updated) != 1 || store.credentials["a@example.com"].PasswordHash != oldPHC {
				t.Fatal("failed update did not retain the old credential")
			}
			assertLogs(t, logs, "WARN", 1, testPassword, oldPHC, store.updated[0].phc)
			logs.Reset()
			if _, err := service.Login(context.Background(), "a@example.com", testPassword); err != nil {
				t.Fatalf("retry Login() error = %v", err)
			}
			if len(store.updated) != 2 {
				t.Error("next login did not retry rehash")
			}
			assertLogs(t, logs, "WARN", 1, testPassword, oldPHC)
		})
	}
}

func TestRehashGenerationFailureDoesNotUpdateCredential(t *testing.T) {
	store := &fakeUserStore{}
	service, logs := mustService(t, store, mustHasher(t, smallParams()))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	service.rehashCredential(ctx, "user-1", mustPassword(t, testPassword))
	if len(store.updated) != 0 {
		t.Error("failed rehash generation attempted a save")
	}
	assertLogs(t, logs, "WARN", 1, testPassword)
}

func TestLoginPropagatesStoreErrors(t *testing.T) {
	for _, failure := range []error{errors.New("lookup failure"), fmt.Errorf("%w: %w", ErrBusy, context.DeadlineExceeded)} {
		t.Run(failure.Error(), func(t *testing.T) {
			store := &fakeUserStore{findErr: failure}
			service, logs := mustService(t, store, mustHasher(t, smallParams()))
			id, err := service.Login(context.Background(), "a@example.com", testPassword)
			if id != "" || !errors.Is(err, failure) || errors.Is(err, ErrInvalidCredentials) {
				t.Fatalf("Login() ID present = %t, error = %v, want underlying failure", id != "", err)
			}
			if errors.Is(failure, context.DeadlineExceeded) && !errors.Is(err, context.DeadlineExceeded) {
				t.Error("lookup error lost the context cause")
			}
			assertLogs(t, logs, "", 0)
		})
	}
}

func TestLoginVerifyBusyAndProgrammingErrors(t *testing.T) {
	hasher := mustHasher(t, smallParams())
	phc := mustPHC(t, hasher, testPassword)
	for _, tt := range []struct {
		name    string
		prepare func(*Service, context.CancelFunc)
		want    error
		cause   error
	}{
		{name: "canceled verification", prepare: func(_ *Service, cancel context.CancelFunc) { cancel() }, want: ErrBusy, cause: context.Canceled},
		{name: "invalid hasher", prepare: func(s *Service, _ context.CancelFunc) { s.hasher = &password.Hasher{} }, want: password.ErrInvalidParams},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeUserStore{credentials: map[string]Credential{"a@example.com": {UserID: "user-1", PasswordHash: phc}}}
			service, logs := mustService(t, store, hasher)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			tt.prepare(service, cancel)
			id, err := service.Login(ctx, "a@example.com", testPassword)
			if id != "" || !errors.Is(err, tt.want) || errors.Is(err, ErrInvalidCredentials) {
				t.Fatalf("Login() ID present = %t, error = %v, want %v", id != "", err, tt.want)
			}
			if tt.cause != nil && !errors.Is(err, tt.cause) {
				t.Error("verification lost the context cause")
			}
			if len(store.updated) != 0 {
				t.Error("failed verification updated the credential")
			}
			assertLogs(t, logs, "", 0)
		})
	}
}

func TestNormalizeEmail(t *testing.T) {
	for _, tt := range []struct {
		input string
		want  string
	}{
		{input: "Person@EXAMPLE.COM", want: "person@example.com"},
		{input: " <Person@EXAMPLE.COM> ", want: "person@example.com"},
	} {
		t.Run(tt.input, func(t *testing.T) {
			normalized, err := normalizeEmail(tt.input)
			if err != nil || normalized != tt.want {
				t.Fatalf("normalizeEmail() = %q, %v; want %q", normalized, err, tt.want)
			}
		})
	}
}
