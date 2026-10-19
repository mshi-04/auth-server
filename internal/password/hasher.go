package password

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"

	"golang.org/x/crypto/argon2"
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
		return nil, fmt.Errorf("create password hasher: %w", err)
	}
	return &Hasher{params: params, slots: make(chan struct{}, params.MaxConcurrent)}, nil
}

func (h *Hasher) Hash(ctx context.Context, password Password) (EncodedHash, error) {
	if password.isZero() {
		return EncodedHash{}, fmt.Errorf("hash password: %w", ErrInvalidPassword)
	}
	if password.secret().runeCount < minPasswordLength {
		return EncodedHash{}, fmt.Errorf("hash password: %w", ErrPolicyViolation)
	}
	encoded, err := h.hash(ctx, password)
	if err != nil {
		return EncodedHash{}, fmt.Errorf("hash password: %w", err)
	}
	return encoded, nil
}

func (h *Hasher) Rehash(ctx context.Context, password Password) (EncodedHash, error) {
	if password.isZero() {
		return EncodedHash{}, fmt.Errorf("rehash password: %w", ErrInvalidPassword)
	}
	encoded, err := h.hash(ctx, password)
	if err != nil {
		return EncodedHash{}, fmt.Errorf("rehash password: %w", err)
	}
	return encoded, nil
}

func (h *Hasher) hash(ctx context.Context, password Password) (EncodedHash, error) {
	if err := h.acquire(ctx); err != nil {
		return EncodedHash{}, err
	}
	defer h.release()

	salt := make([]byte, h.params.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return EncodedHash{}, fmt.Errorf("generate password salt: %w", err)
	}
	key := deriveKey([]byte(password.secret().value), salt,
		h.params.Iterations, h.params.MemoryKiB, h.params.Parallelism, h.params.KeyLength)
	return EncodedHash{hash: seal(encodedHash{
		phc:     encodeHash(h.params, salt, key),
		decoded: decodedHash{params: h.params, salt: salt, key: key},
	})}, nil
}

func (h *Hasher) Verify(ctx context.Context, password Password, encoded EncodedHash) (bool, error) {
	if password.isZero() {
		return false, fmt.Errorf("verify password: %w", ErrInvalidPassword)
	}
	if encoded.isZero() {
		return false, fmt.Errorf("verify password: %w", ErrInvalidHash)
	}
	if err := h.acquire(ctx); err != nil {
		return false, fmt.Errorf("verify password: %w", err)
	}
	defer h.release()

	decoded := encoded.hash().decoded
	key := deriveKey([]byte(password.secret().value), decoded.salt,
		decoded.params.Iterations, decoded.params.MemoryKiB,
		decoded.params.Parallelism, decoded.params.KeyLength)
	return subtle.ConstantTimeCompare(key, decoded.key) == 1, nil
}

func (h *Hasher) NeedsRehash(encoded EncodedHash) bool {
	if !h.usable() || encoded.isZero() {
		return false
	}
	decoded := encoded.hash().decoded
	return decoded.params.MemoryKiB != h.params.MemoryKiB ||
		decoded.params.Iterations != h.params.Iterations ||
		decoded.params.Parallelism != h.params.Parallelism ||
		decoded.params.SaltLength != h.params.SaltLength ||
		decoded.params.KeyLength != h.params.KeyLength ||
		!encoded.hash().canonical()
}

func (h *Hasher) usable() bool {
	return h != nil && h.slots != nil
}

func (h *Hasher) acquire(ctx context.Context) error {
	if !h.usable() {
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
