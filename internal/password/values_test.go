package password

import (
	"bytes"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func TestParsePassword(t *testing.T) {
	tests := []struct {
		name  string
		raw   string
		value string
		count int
	}{
		{"empty", "", "", 0},
		{"eleven_characters", strings.Repeat("a", 11), strings.Repeat("a", 11), 11},
		{"twelve_characters", strings.Repeat("a", 12), strings.Repeat("a", 12), 12},
		{"ascii_maximum", strings.Repeat("a", 128), strings.Repeat("a", 128), 128},
		{"japanese_maximum", strings.Repeat("あ", 128), strings.Repeat("あ", 128), 128},
		{"emoji_maximum", strings.Repeat("😀", 128), strings.Repeat("😀", 128), 128},
		{"fullwidth_ascii", "ＡＢＣ１２３", "ABC123", 6},
		{"halfwidth_katakana", "ｶﾞ", "ガ", 1},
		{"combined_accent", "e\u0301", "é", 1},
		{"normalization_expands_to_maximum", strings.Repeat("㍿", 32), strings.Repeat("株式会社", 32), 128},
		{"normalization_reduces_to_maximum", strings.Repeat("ｶﾞ", 128), strings.Repeat("ガ", 128), 128},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParsePassword(tt.raw)
			if err != nil {
				t.Fatalf("ParsePassword() error = %v", err)
			}
			if got.isZero() || got.secret().value != tt.value || got.secret().runeCount != tt.count {
				t.Fatal("parsed password does not have the expected normalized value and count")
			}
		})
	}
}

func TestParsePasswordRejectsInvalidInput(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{"ascii_over_maximum", strings.Repeat("a", 129)},
		{"japanese_over_maximum", strings.Repeat("あ", 129)},
		{"emoji_over_maximum", strings.Repeat("😀", 129)},
		{"normalization_expands_over_maximum", strings.Repeat("㍿", 33)},
		{"normalization_reduces_over_maximum", strings.Repeat("e\u0301", 129)},
		{"invalid_utf8", "private-password-\xff"},
		{"truncated_utf8", "private-password-\xe3\x81"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParsePassword(tt.raw)
			if !errors.Is(err, ErrPolicyViolation) {
				t.Fatalf("ParsePassword() error = %v, want ErrPolicyViolation", err)
			}
			if !got.isZero() {
				t.Fatal("failed parsing returned an initialized password")
			}
			if strings.Contains(err.Error(), tt.raw) || strings.Contains(err.Error(), "private-password") {
				t.Fatal("error contains password input")
			}
		})
	}
}

func TestParsedEmptyPasswordDiffersFromZero(t *testing.T) {
	parsed, err := ParsePassword("")
	if err != nil {
		t.Fatalf("ParsePassword() error = %v", err)
	}
	var zero Password
	if parsed.isZero() || !zero.isZero() || parsed.secret().value != "" || parsed.secret().runeCount != 0 {
		t.Fatal("parsed empty password is not distinguishable from an uninitialized password")
	}
}

func TestEncodedHashZeroPHC(t *testing.T) {
	var zero EncodedHash
	got, err := zero.PHC()
	if got != "" || !errors.Is(err, ErrInvalidHash) {
		t.Fatalf("zero PHC() error = %v, want empty string and ErrInvalidHash", err)
	}
}

func TestSecretValuesFormatting(t *testing.T) {
	const secret = "private-password"
	p, err := ParsePassword(secret)
	if err != nil {
		t.Fatalf("ParsePassword() error = %v", err)
	}
	h, err := ParseEncodedHash(fixturePHC)
	if err != nil {
		t.Fatalf("ParseEncodedHash() error = %v", err)
	}
	var zeroPassword Password
	var zeroHash EncodedHash
	tests := []struct {
		name   string
		value  any
		direct bool
	}{
		{"password", p, true},
		{"password_pointer", &p, true},
		{"zero_password", zeroPassword, true},
		{"zero_password_pointer", &zeroPassword, true},
		{"hash", h, true},
		{"hash_pointer", &h, true},
		{"zero_hash", zeroHash, true},
		{"zero_hash_pointer", &zeroHash, true},
		{"exported_password_field", struct{ Value Password }{p}, false},
		{"exported_hash_field", struct{ Value EncodedHash }{h}, false},
		{"nested_exported_fields", struct{ Value any }{struct{ Secret any }{p}}, false},
		{"nested_pointer", struct{ Value any }{&h}, false},
		{"password_slice", []Password{p}, false},
		{"hash_slice", []EncodedHash{h}, false},
		{"password_map", map[string]Password{"value": p}, false},
		{"hash_map", map[string]EncodedHash{"value": h}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, verb := range []string{
				"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d", "%t", "%b", "%o",
				"%U", "%c", "%e", "%f", "%g", "%10v", "%-12s", "%08d",
			} {
				t.Run(verb, func(t *testing.T) {
					got := fmt.Sprintf(verb, tt.value)
					if strings.Contains(got, secret) || strings.Contains(got, fixturePHC) || !strings.Contains(got, "[REDACTED]") {
						t.Fatal("formatted value does not redact its secret")
					}
					if tt.direct {
						want := "[REDACTED]"
						if verb == "%q" {
							want = `"[REDACTED]"`
						}
						if got != want {
							t.Fatal("direct formatting did not return the fixed redaction")
						}
					}
				})
			}
		})
	}
}

func TestSecretValuesInUnexportedFields(t *testing.T) {
	const secret = "private-password"
	type holder struct {
		password Password
		hash     EncodedHash
	}
	value := holder{mustPassword(t, secret), mustEncodedHash(t, fixturePHC)}
	salt := strings.Split(fixturePHC, "$")[4]
	leaks := []string{secret, fixturePHC, salt, "0 1 2 3 4 5", "0x0, 0x1, 0x2"}
	outputs := map[string]string{}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%d", "%x"} {
		outputs[verb] = fmt.Sprintf(verb, value)
	}
	var logged bytes.Buffer
	slog.New(slog.NewTextHandler(&logged, nil)).Info("login", slog.Any("holder", value))
	outputs["slog_text"] = logged.String()
	for name, got := range outputs {
		for _, leak := range leaks {
			if strings.Contains(got, leak) {
				t.Errorf("%s output leaks secret material", name)
			}
		}
	}
}
