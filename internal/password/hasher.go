package password

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
	"golang.org/x/text/unicode/norm"
)

const (
	minPasswordLength = 12
	maxPasswordLength = 128
)

var (
	ErrPolicyViolation = errors.New("password policy violation")
	ErrBusy            = errors.New("password hasher busy")
)

var deriveKey = argon2.IDKey

type Hasher struct {
	params Params
	slots  chan struct{}
}

func New(params Params) (*Hasher, error) {
	if err := params.validate(); err != nil {
		return nil, err
	}
	return &Hasher{params: params, slots: make(chan struct{}, params.MaxConcurrent)}, nil
}

func (h *Hasher) Hash(ctx context.Context, password string) (string, error) {
	normalized := normalize(password)
	length := utf8.RuneCountInString(normalized)
	if !utf8.ValidString(normalized) || length < minPasswordLength || length > maxPasswordLength {
		return "", ErrPolicyViolation
	}
	if err := h.acquire(ctx); err != nil {
		return "", err
	}
	defer h.release()

	salt := make([]byte, h.params.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := deriveKey([]byte(normalized), salt,
		h.params.Iterations, h.params.MemoryKiB, h.params.Parallelism, h.params.KeyLength)
	return encodeHash(h.params, salt, key), nil
}

func (h *Hasher) Verify(ctx context.Context, password, encoded string) (bool, error) {
	normalized := normalize(password)
	if !utf8.ValidString(normalized) || utf8.RuneCountInString(normalized) > maxPasswordLength {
		return false, nil
	}
	decoded, err := parseHash(encoded)
	if err != nil {
		return false, err
	}
	if err := h.acquire(ctx); err != nil {
		return false, err
	}
	defer h.release()

	key := deriveKey([]byte(normalized), decoded.salt,
		decoded.params.Iterations, decoded.params.MemoryKiB,
		decoded.params.Parallelism, decoded.params.KeyLength)
	return subtle.ConstantTimeCompare(key, decoded.key) == 1, nil
}

func (h *Hasher) NeedsRehash(encoded string) bool {
	decoded, err := parseHash(encoded)
	if err != nil {
		return true
	}
	return decoded.params.MemoryKiB != h.params.MemoryKiB ||
		decoded.params.Iterations != h.params.Iterations ||
		decoded.params.Parallelism != h.params.Parallelism ||
		decoded.params.SaltLength != h.params.SaltLength ||
		decoded.params.KeyLength != h.params.KeyLength
}

func normalize(password string) string {
	return norm.NFKC.String(password)
}

func (h *Hasher) acquire(ctx context.Context) error {
	if h.slots == nil {
		return ErrInvalidParams
	}
	waitCtx, cancel := context.WithTimeout(ctx, h.params.WaitTimeout)
	defer cancel()
	select {
	case h.slots <- struct{}{}:
		// 空き枠とキャンセルが同時に準備できると、select は空き枠を選ぶこともある。
		if waitCtx.Err() != nil {
			h.release()
			return busy(ctx)
		}
		return nil
	case <-waitCtx.Done():
		return busy(ctx)
	}
}

func busy(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("%w: %w", ErrBusy, err)
	}
	return ErrBusy
}

func (h *Hasher) release() {
	<-h.slots
}
