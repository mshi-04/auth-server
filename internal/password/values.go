package password

import (
	"errors"
	"fmt"
	"io"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const redacted = "[REDACTED]"

var ErrInvalidPassword = errors.New("invalid password value")

// fmt はどの書式でも関数値をアドレスとしてしか表示せず、中身をたどらない。
// ポインタや構造体で持つと、非公開フィールドを不正な書式で表示したときに中身が展開されるため、
// 秘密は関数の戻り値として保持する。
type sealed[T any] func() T

func seal[T any](value T) sealed[T] {
	return func() T { return value }
}

type Password struct {
	secret sealed[passwordSecret]
}

type passwordSecret struct {
	value     string
	runeCount int
}

func ParsePassword(raw string) (Password, error) {
	value := norm.NFKC.String(raw)
	count := utf8.RuneCountInString(value)
	if !utf8.ValidString(value) || count > maxPasswordLength {
		return Password{}, fmt.Errorf("parse password: %w", ErrPolicyViolation)
	}
	return Password{secret: seal(passwordSecret{value: value, runeCount: count})}, nil
}

func (p Password) isZero() bool {
	return p.secret == nil
}

func (p Password) String() string {
	return redacted
}

func (p Password) GoString() string {
	return redacted
}

func (p Password) Format(f fmt.State, verb rune) {
	formatRedacted(f, verb)
}

type EncodedHash struct {
	hash sealed[encodedHash]
}

type encodedHash struct {
	phc     string
	decoded decodedHash
}

func ParseEncodedHash(encoded string) (EncodedHash, error) {
	decoded, err := parseHash(encoded)
	if err != nil {
		return EncodedHash{}, fmt.Errorf("parse password hash: %w", err)
	}
	return EncodedHash{hash: seal(encodedHash{phc: encoded, decoded: decoded})}, nil
}

func (h EncodedHash) isZero() bool {
	return h.hash == nil
}

func (h EncodedHash) PHC() (string, error) {
	if h.isZero() {
		return "", fmt.Errorf("read password hash: %w", ErrInvalidHash)
	}
	return h.hash().phc, nil
}

func (h EncodedHash) String() string {
	return redacted
}

func (h EncodedHash) GoString() string {
	return redacted
}

func (h EncodedHash) Format(f fmt.State, verb rune) {
	formatRedacted(f, verb)
}

func (e encodedHash) canonical() bool {
	return e.phc == encodeHash(e.decoded.params, e.decoded.salt, e.decoded.key)
}

func formatRedacted(f fmt.State, verb rune) {
	if verb == 'q' {
		fmt.Fprintf(f, "%q", redacted)
		return
	}
	io.WriteString(f, redacted)
}
