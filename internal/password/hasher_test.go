package password

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"golang.org/x/crypto/argon2"
)

const validPassword = "correct horse battery staple"

func smallParams() Params {
	params := DefaultParams()
	params.MemoryKiB = 64
	params.Iterations = 1
	params.Parallelism = 1
	params.MaxConcurrent = 2
	return params
}

func newTestHasher(t testing.TB) *Hasher {
	t.Helper()
	hasher, err := New(smallParams())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return hasher
}

func mustHash(t testing.TB, hasher *Hasher, password string) string {
	t.Helper()
	encoded, err := hasher.Hash(context.Background(), password)
	if err != nil {
		t.Fatalf("Hash() error = %v", err)
	}
	return encoded
}

func TestNewRejectsInvalidParams(t *testing.T) {
	hasher, err := New(Params{})
	if hasher != nil || !errors.Is(err, ErrInvalidParams) {
		t.Fatalf("New(zero parameters): hasher present = %t, error = %v", hasher != nil, err)
	}
}

func TestNewKeepsParamsAndSemaphore(t *testing.T) {
	params := smallParams()
	hasher, err := New(params)
	if err != nil {
		t.Fatal(err)
	}
	if hasher.params != params || cap(hasher.slots) != params.MaxConcurrent {
		t.Fatalf("New() kept params %+v and %d slots, want %+v and %d",
			hasher.params, cap(hasher.slots), params, params.MaxConcurrent)
	}
}

func TestZeroValueHasher(t *testing.T) {
	var hasher Hasher
	for name, operation := range testOperations(&hasher, fixturePHC) {
		t.Run(name, func(t *testing.T) {
			if err := operation(context.Background()); !errors.Is(err, ErrInvalidParams) {
				t.Fatalf("zero-value Hasher: got %v, want ErrInvalidParams", err)
			}
		})
	}
}

func TestHashVerify(t *testing.T) {
	hasher := newTestHasher(t)
	encoded := mustHash(t, hasher, validPassword)
	for _, tt := range []struct {
		name     string
		password string
		want     bool
	}{
		{"correct", validPassword, true},
		{"incorrect", "incorrect horse battery staple", false},
		{"empty", "", false},
		{"short", "short", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ok, err := hasher.Verify(context.Background(), tt.password, encoded)
			if err != nil || ok != tt.want {
				t.Fatalf("Verify(): match = %t, error = %v, want match = %t", ok, err, tt.want)
			}
		})
	}
}

func TestHashUsesFreshSalt(t *testing.T) {
	hasher := newTestHasher(t)
	first, err := parseHash(mustHash(t, hasher, validPassword))
	if err != nil {
		t.Fatal(err)
	}
	second, err := parseHash(mustHash(t, hasher, validPassword))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first.salt, second.salt) || bytes.Equal(first.key, second.key) {
		t.Fatal("repeated hashes reused a salt or key")
	}
}

func TestNormalizationConsistency(t *testing.T) {
	tests := []struct {
		name   string
		stored string
		input  string
	}{
		{"full_to_half", "ＡＢＣ１２３ａｂｃ４５６", "ABC123abc456"},
		{"half_to_full", "ABC123abc456", "ＡＢＣ１２３ａｂｃ４５６"},
		{"combining_to_composed", strings.Repeat("e\u0301", 12), strings.Repeat("é", 12)},
		{"composed_to_combining", strings.Repeat("é", 12), strings.Repeat("e\u0301", 12)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hasher := newTestHasher(t)
			encoded := mustHash(t, hasher, tt.stored)
			if ok, err := hasher.Verify(context.Background(), tt.input, encoded); err != nil || !ok {
				t.Fatalf("equivalent normalized input: match = %t, error = %v", ok, err)
			}
		})
	}
}

func TestHashPolicy(t *testing.T) {
	tests := []struct {
		name     string
		password string
		valid    bool
	}{
		{"empty", "", false},
		{"eleven", strings.Repeat("a", 11), false},
		{"twelve", strings.Repeat("a", 12), true},
		{"maximum", strings.Repeat("a", 128), true},
		{"over_maximum", strings.Repeat("a", 129), false},
		{"japanese", strings.Repeat("あ", 12), true},
		{"emoji_eleven", strings.Repeat("😀", 11), false},
		{"emoji_twelve", strings.Repeat("😀", 12), true},
		{"emoji_maximum", strings.Repeat("😀", 128), true},
		{"emoji_over_maximum", strings.Repeat("😀", 129), false},
		{"expands_below_minimum", strings.Repeat("㍿", 2), false},
		{"expands_to_minimum", strings.Repeat("㍿", 3), true},
		{"expands_to_maximum", strings.Repeat("㍿", 32), true},
		{"expands_over_maximum", strings.Repeat("㍿", 33), false},
		{"contracts_below_minimum", strings.Repeat("e\u0301", 11), false},
		{"contracts_to_minimum", strings.Repeat("e\u0301", 12), true},
		{"contracts_to_maximum", strings.Repeat("e\u0301", 128), true},
		{"contracts_over_maximum", strings.Repeat("e\u0301", 129), false},
		{"invalid_utf8", strings.Repeat("\xff", 12), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hasher := newTestHasher(t)
			encoded, err := hasher.Hash(context.Background(), tt.password)
			if !tt.valid {
				if encoded != "" || !errors.Is(err, ErrPolicyViolation) {
					t.Fatalf("invalid password: output present = %t, error = %v", encoded != "", err)
				}
				if tt.password != "" && strings.Contains(err.Error(), tt.password) {
					t.Fatal("error contains the password input")
				}
				return
			}
			if err != nil {
				t.Fatalf("valid password rejected: %v", err)
			}
			if ok, err := hasher.Verify(context.Background(), tt.password, encoded); err != nil || !ok {
				t.Fatalf("valid password did not verify: match = %t, error = %v", ok, err)
			}
		})
	}
}

func TestVerifyExistingShortPassword(t *testing.T) {
	salt := []byte("legacy-salt-1234")
	key := argon2.IDKey([]byte("old"), salt, 1, 64, 1, 32)
	encoded := "$argon2id$v=19$m=64,t=1,p=1$" +
		base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key)
	if ok, err := newTestHasher(t).Verify(context.Background(), "old", encoded); err != nil || !ok {
		t.Fatalf("existing short credential: match = %t, error = %v", ok, err)
	}
}

func TestVerifyMaximumLengthBeforePHC(t *testing.T) {
	hasher := newTestHasher(t)
	for _, password := range []string{strings.Repeat("a", 129), strings.Repeat("㍿", 33)} {
		ok, err := hasher.Verify(context.Background(), password, "invalid PHC")
		if ok || err != nil {
			t.Fatalf("overlong input: match = %t, error = %v, want false and nil", ok, err)
		}
	}
}

func TestVerifyRejectsInvalidUTF8(t *testing.T) {
	password := strings.Repeat("\xff", 12)
	salt := []byte("legacy-salt-1234")
	key := argon2.IDKey([]byte(password), salt, 1, 64, 1, 32)
	encoded := encodeHash(Params{MemoryKiB: 64, Iterations: 1, Parallelism: 1}, salt, key)
	if ok, err := newTestHasher(t).Verify(context.Background(), password, encoded); ok || err != nil {
		t.Fatalf("invalid UTF-8 input: match = %t, error = %v, want false and nil", ok, err)
	}
}

func TestVerifyRejectsInvalidPHC(t *testing.T) {
	ok, err := newTestHasher(t).Verify(context.Background(), validPassword, "invalid PHC")
	if ok || !errors.Is(err, ErrInvalidHash) {
		t.Fatalf("invalid PHC: match = %t, error = %v", ok, err)
	}
}

func TestNeedsRehashAndStoredParameters(t *testing.T) {
	tests := []struct {
		name   string
		change func(*Params)
		want   bool
	}{
		{"same", func(p *Params) {}, false},
		{"memory", func(p *Params) { p.MemoryKiB = 128 }, true},
		{"iterations", func(p *Params) { p.Iterations = 2 }, true},
		{"parallelism", func(p *Params) { p.Parallelism = 2 }, true},
		{"salt_length", func(p *Params) { p.SaltLength = 32 }, true},
		{"key_length", func(p *Params) { p.KeyLength = 16 }, true},
		{"concurrency", func(p *Params) { p.MaxConcurrent = 1 }, false},
		{"timeout", func(p *Params) { p.WaitTimeout = time.Second }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := smallParams()
			tt.change(&params)
			oldHasher, err := New(params)
			if err != nil {
				t.Fatal(err)
			}
			encoded := mustHash(t, oldHasher, validPassword)
			current := newTestHasher(t)
			if got := current.NeedsRehash(encoded); got != tt.want {
				t.Fatalf("NeedsRehash() = %t, want %t", got, tt.want)
			}
			if ok, err := current.Verify(context.Background(), validPassword, encoded); err != nil || !ok {
				t.Fatalf("stored parameters were not used: match = %t, error = %v", ok, err)
			}
		})
	}
}

func TestNeedsRehashInvalidPHC(t *testing.T) {
	hasher := newTestHasher(t)
	for _, encoded := range []string{"", "invalid PHC", strings.Replace(fixturePHC, "t=1", "t=11", 1)} {
		if !hasher.NeedsRehash(encoded) {
			t.Fatal("invalid PHC did not require rehash")
		}
	}
}

func testOperations(hasher *Hasher, encoded string) map[string]func(context.Context) error {
	return map[string]func(context.Context) error{
		"hash": func(ctx context.Context) error {
			_, err := hasher.Hash(ctx, validPassword)
			return err
		},
		"verify": func(ctx context.Context) error {
			_, err := hasher.Verify(ctx, validPassword, encoded)
			return err
		},
	}
}

func TestSemaphoreTimeoutAndReuse(t *testing.T) {
	for _, name := range []string{"hash", "verify"} {
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				hasher := newTestHasher(t)
				operation := testOperations(hasher, mustHash(t, hasher, validPassword))[name]
				for range cap(hasher.slots) {
					hasher.slots <- struct{}{}
				}
				start := time.Now()
				if err := operation(context.Background()); !errors.Is(err, ErrBusy) || errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("occupied semaphore: got %v, want ErrBusy without a context error", err)
				}
				if elapsed := time.Since(start); elapsed != hasher.params.WaitTimeout {
					t.Fatalf("virtual wait = %v, want %v", elapsed, hasher.params.WaitTimeout)
				}
				if len(hasher.slots) != cap(hasher.slots) {
					t.Fatal("timed-out operation changed occupied slots")
				}
				<-hasher.slots
				if err := operation(context.Background()); err != nil {
					t.Fatalf("operation after releasing a slot: %v", err)
				}
				if len(hasher.slots) != cap(hasher.slots)-1 {
					t.Fatal("successful operation leaked a slot")
				}
				for len(hasher.slots) > 0 {
					<-hasher.slots
				}
			})
		})
	}
}

func TestSemaphoreCanceledBeforeAcquire(t *testing.T) {
	for _, occupied := range []bool{false, true} {
		hasher := newTestHasher(t)
		encoded := mustHash(t, hasher, validPassword)
		if occupied {
			for range cap(hasher.slots) {
				hasher.slots <- struct{}{}
			}
		}
		wantOccupied := len(hasher.slots)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		for name, operation := range testOperations(hasher, encoded) {
			t.Run(name+"/occupied="+map[bool]string{false: "false", true: "true"}[occupied], func(t *testing.T) {
				// select は空き枠と Done をランダムに選ぶため、取得後に枠を返す分岐も通るよう繰り返す。
				for range 64 {
					if err := operation(ctx); !errors.Is(err, ErrBusy) || !errors.Is(err, context.Canceled) {
						t.Fatalf("canceled context: got %v, want ErrBusy wrapping context.Canceled", err)
					}
					if len(hasher.slots) != wantOccupied {
						t.Fatal("canceled operation changed occupied slots")
					}
				}
			})
		}
	}
}

func TestSemaphoreCanceledWhileWaiting(t *testing.T) {
	for _, name := range []string{"hash", "verify"} {
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				hasher := newTestHasher(t)
				operation := testOperations(hasher, mustHash(t, hasher, validPassword))[name]
				for range cap(hasher.slots) {
					hasher.slots <- struct{}{}
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				result := make(chan error, 1)
				go func() { result <- operation(ctx) }()
				synctest.Wait()
				cancel()
				if err := <-result; !errors.Is(err, ErrBusy) || !errors.Is(err, context.Canceled) {
					t.Fatalf("canceled waiter: got %v, want ErrBusy wrapping context.Canceled", err)
				}
				if len(hasher.slots) != cap(hasher.slots) {
					t.Fatal("canceled waiter changed occupied slots")
				}
				for len(hasher.slots) > 0 {
					<-hasher.slots
				}
				if err := operation(context.Background()); err != nil {
					t.Fatalf("operation after cancellation: %v", err)
				}
			})
		})
	}
}

func TestSemaphoreContextDeadline(t *testing.T) {
	for _, name := range []string{"hash", "verify"} {
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				hasher := newTestHasher(t)
				operation := testOperations(hasher, mustHash(t, hasher, validPassword))[name]
				for range cap(hasher.slots) {
					hasher.slots <- struct{}{}
				}
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				start := time.Now()
				if err := operation(ctx); !errors.Is(err, ErrBusy) || !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("parent deadline: got %v, want ErrBusy wrapping context.DeadlineExceeded", err)
				}
				if elapsed := time.Since(start); elapsed != time.Second {
					t.Fatalf("virtual wait = %v, want 1s", elapsed)
				}
			})
		})
	}
}

func TestConcurrentHashAndVerify(t *testing.T) {
	hasher := newTestHasher(t)
	const workers = 8
	var group sync.WaitGroup
	failures := make(chan error, workers)
	for range workers {
		group.Go(func() {
			encoded, err := hasher.Hash(context.Background(), validPassword)
			if err != nil {
				failures <- err
				return
			}
			ok, err := hasher.Verify(context.Background(), validPassword, encoded)
			if err != nil {
				failures <- err
			} else if !ok {
				failures <- errors.New("concurrent round trip did not match")
			}
		})
	}
	group.Wait()
	close(failures)
	for err := range failures {
		t.Errorf("concurrent operation failed: %v", err)
	}
	if len(hasher.slots) != 0 {
		t.Fatal("concurrent operations leaked semaphore slots")
	}
}

func TestSlotHeldDuringDerivation(t *testing.T) {
	for _, name := range []string{"hash", "verify"} {
		t.Run(name, func(t *testing.T) {
			hasher := newTestHasher(t)
			operation := testOperations(hasher, mustHash(t, hasher, validPassword))[name]
			original := deriveKey
			t.Cleanup(func() { deriveKey = original })
			var held []int
			deriveKey = func(password, salt []byte, iterations, memoryKiB uint32, threads uint8, keyLength uint32) []byte {
				held = append(held, len(hasher.slots))
				return original(password, salt, iterations, memoryKiB, threads, keyLength)
			}
			if err := operation(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(held) != 1 || held[0] != 1 || len(hasher.slots) != 0 {
				t.Fatalf("slots during derivation = %v, after = %d, want [1] and 0", held, len(hasher.slots))
			}
		})
	}
}

func BenchmarkHash(b *testing.B) {
	hasher, err := New(DefaultParams())
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := hasher.Hash(context.Background(), validPassword); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkHashSaturated(b *testing.B) {
	params := DefaultParams()
	hasher, err := New(params)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		var group sync.WaitGroup
		for range params.MaxConcurrent {
			group.Go(func() {
				if _, err := hasher.Hash(context.Background(), validPassword); err != nil {
					b.Error(err)
				}
			})
		}
		group.Wait()
	}
}

func BenchmarkHashCandidates(b *testing.B) {
	for _, memoryKiB := range []uint32{64 * 1024, 128 * 1024} {
		for iterations := uint32(2); iterations <= 10; iterations++ {
			b.Run(fmt.Sprintf("m=%d,t=%d", memoryKiB, iterations), func(b *testing.B) {
				params := DefaultParams()
				params.MemoryKiB = memoryKiB
				params.Iterations = iterations
				hasher, err := New(params)
				if err != nil {
					b.Fatal(err)
				}
				for b.Loop() {
					if _, err := hasher.Hash(context.Background(), validPassword); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}
