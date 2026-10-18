package password

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

const fixturePHC = "$argon2id$v=19$m=64,t=1,p=1$AAECAwQFBgcICQoLDA0ODw$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func TestEncodeHash(t *testing.T) {
	params := Params{MemoryKiB: 64, Iterations: 1, Parallelism: 1}
	salt := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	if got := encodeHash(params, salt, make([]byte, 32)); got != fixturePHC {
		t.Fatal("encoded PHC does not match the fixed fixture")
	}
}

func TestParseHash(t *testing.T) {
	got, err := parseHash(fixturePHC)
	if err != nil {
		t.Fatalf("parseHash() error = %v", err)
	}
	want := Params{MemoryKiB: 64, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32}
	if got.params != want {
		t.Fatalf("parsed parameters = %+v, want %+v", got.params, want)
	}
	if !bytes.Equal(got.salt, []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}) ||
		!bytes.Equal(got.key, make([]byte, 32)) {
		t.Fatal("parsed bytes do not match the fixed fixture")
	}
}

func TestParseHashAcceptsParameterOrder(t *testing.T) {
	for _, cost := range []string{
		"m=64,t=1,p=1", "m=64,p=1,t=1", "t=1,m=64,p=1",
		"t=1,p=1,m=64", "p=1,m=64,t=1", "p=1,t=1,m=64",
	} {
		t.Run(cost, func(t *testing.T) {
			encoded := strings.Replace(fixturePHC, "m=64,t=1,p=1", cost, 1)
			if _, err := parseHash(encoded); err != nil {
				t.Fatalf("valid parameter order rejected: %v", err)
			}
		})
	}
}

func TestParseHashAcceptsBounds(t *testing.T) {
	tests := []struct {
		name string
		cost string
		salt string
		key  string
	}{
		{"minimum", "m=8,t=1,p=1", "AA", "AAAAAA"},
		{"maximum", "m=262144,t=10,p=16", strings.Repeat("A", 86), strings.Repeat("A", 86)},
		{"memory_relative_to_parallelism", "m=128,t=1,p=16", "AA", "AAAAAA"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			encoded := "$argon2id$v=19$" + tt.cost + "$" + tt.salt + "$" + tt.key
			if _, err := parseHash(encoded); err != nil {
				t.Fatalf("valid parameter bounds rejected: %v", err)
			}
		})
	}
}

func TestParseHashRejectsInvalidPHC(t *testing.T) {
	parts := strings.Split(fixturePHC, "$")
	withCost := func(cost string) string {
		return "$argon2id$v=19$" + cost + "$" + parts[4] + "$" + parts[5]
	}
	withSalt := func(salt string) string {
		return "$argon2id$v=19$m=64,t=1,p=1$" + salt + "$" + parts[5]
	}
	withKey := func(key string) string {
		return "$argon2id$v=19$m=64,t=1,p=1$" + parts[4] + "$" + key
	}
	tests := []struct {
		name    string
		encoded string
	}{
		{"empty", ""},
		{"missing_prefix", fixturePHC[1:]},
		{"wrong_algorithm", strings.Replace(fixturePHC, "argon2id", "argon2i", 1)},
		{"wrong_version", strings.Replace(fixturePHC, "v=19", "v=18", 1)},
		{"malformed_version", strings.Replace(fixturePHC, "v=19", "v=19extra", 1)},
		{"missing_version", strings.Replace(fixturePHC, "$v=19", "", 1)},
		{"extra_component", fixturePHC + "$extra"},
		{"missing_component", strings.Join(parts[:5], "$")},
		{"missing_parameter", withCost("m=64,p=1")},
		{"extra_parameter", withCost("m=64,t=1,p=1,q=1")},
		{"duplicate_parameter", withCost("m=64,m=64,p=1")},
		{"unknown_parameter", withCost("m=64,t=1,q=1")},
		{"missing_equals", withCost("m64,t=1,p=1")},
		{"missing_value", withCost("m=,t=1,p=1")},
		{"empty_parameter", withCost("m=64,,p=1")},
		{"zero_memory", withCost("m=0,t=1,p=1")},
		{"leading_zero_memory", withCost("m=064,t=1,p=1")},
		{"leading_zero_iterations", withCost("m=64,t=01,p=1")},
		{"leading_zero_parallelism", withCost("m=64,t=1,p=01")},
		{"insufficient_memory", withCost("m=15,t=1,p=2")},
		{"memory_over_limit", withCost("m=262145,t=1,p=1")},
		{"memory_overflow", withCost("m=4294967296,t=1,p=1")},
		{"zero_iterations", withCost("m=64,t=0,p=1")},
		{"iterations_over_limit", withCost("m=64,t=11,p=1")},
		{"iterations_overflow", withCost("m=64,t=4294967296,p=1")},
		{"zero_parallelism", withCost("m=64,t=1,p=0")},
		{"parallelism_over_limit", withCost("m=1024,t=1,p=17")},
		{"parallelism_wraparound", withCost("m=64,t=1,p=257")},
		{"parallelism_overflow", withCost("m=64,t=1,p=4294967296")},
		{"negative_number", withCost("m=-64,t=1,p=1")},
		{"positive_sign", withCost("m=+64,t=1,p=1")},
		{"non_ascii_number", withCost("m=６４,t=1,p=1")},
		{"decimal_number", withCost("m=64,t=1.0,p=1")},
		{"trailing_data", withCost("m=64,t=1,p=1extra")},
		{"whitespace", withCost("m=64, t=1,p=1")},
		{"salt_empty", withSalt("")},
		{"salt_padded", withSalt(parts[4] + "==")},
		{"salt_invalid_character", withSalt("!A")},
		{"salt_url_alphabet", withSalt("_w")},
		{"salt_newline", withSalt(parts[4] + "\n")},
		{"salt_carriage_return", withSalt(parts[4] + "\r")},
		{"salt_noncanonical_bits", withSalt("AB")},
		{"salt_invalid_length", withSalt("A")},
		{"salt_over_limit", withSalt(strings.Repeat("A", 87))},
		{"key_empty", withKey("")},
		{"key_too_short", withKey("AAAA")},
		{"key_padded", withKey(parts[5] + "=")},
		{"key_invalid_character", withKey(strings.Repeat("!", 43))},
		{"key_url_alphabet", withKey(strings.Repeat("_", 43))},
		{"key_newline", withKey(parts[5] + "\n")},
		{"key_carriage_return", withKey(parts[5] + "\r")},
		{"key_noncanonical_bits", withKey(strings.Repeat("A", 42) + "B")},
		{"key_invalid_length", withKey(strings.Repeat("A", 9))},
		{"key_over_limit", withKey(strings.Repeat("A", 87))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseHash(tt.encoded)
			if !errors.Is(err, ErrInvalidHash) {
				t.Fatalf("got error %v, want ErrInvalidHash", err)
			}
			if tt.encoded != "" && strings.Contains(err.Error(), tt.encoded) {
				t.Fatal("error contains the PHC input")
			}
		})
	}
}
