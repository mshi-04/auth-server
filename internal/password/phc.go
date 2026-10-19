package password

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

var ErrInvalidHash = errors.New("invalid password hash")

type decodedHash struct {
	params Params
	salt   []byte
	key    []byte
}

func encodeHash(params Params, salt, key []byte) string {
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, params.MemoryKiB, params.Iterations, params.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key))
}

func parseHash(encoded string) (decodedHash, error) {
	parts := strings.SplitN(encoded, "$", 7)
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19" {
		return decodedHash{}, ErrInvalidHash
	}
	params, err := parseCost(parts[3])
	if err != nil {
		return decodedHash{}, err
	}
	salt, err := decodeHashPart(parts[4], 1, maxSaltLength)
	if err != nil {
		return decodedHash{}, err
	}
	key, err := decodeHashPart(parts[5], minKeyLength, maxKeyLength)
	if err != nil {
		return decodedHash{}, err
	}
	params.SaltLength = uint32(len(salt))
	params.KeyLength = uint32(len(key))
	return decodedHash{params: params, salt: salt, key: key}, nil
}

func parseCost(encoded string) (Params, error) {
	fields := strings.SplitN(encoded, ",", 4)
	if len(fields) != 3 {
		return Params{}, ErrInvalidHash
	}
	var params Params
	var seen uint8
	for _, field := range fields {
		name, value, ok := strings.Cut(field, "=")
		if !ok || value == "" || value[0] == '0' {
			return Params{}, ErrInvalidHash
		}
		for _, digit := range value {
			if digit < '0' || digit > '9' {
				return Params{}, ErrInvalidHash
			}
		}
		number, err := strconv.ParseUint(value, 10, 32)
		if err != nil {
			return Params{}, ErrInvalidHash
		}
		var bit uint8
		switch name {
		case "m":
			bit = 1
			params.MemoryKiB = uint32(number)
		case "t":
			bit = 2
			params.Iterations = uint32(number)
		case "p":
			if number > maxParallelism {
				return Params{}, ErrInvalidHash
			}
			bit = 4
			params.Parallelism = uint8(number)
		default:
			return Params{}, ErrInvalidHash
		}
		if seen&bit != 0 {
			return Params{}, ErrInvalidHash
		}
		seen |= bit
	}
	if seen != 7 || !params.validCost() {
		return Params{}, ErrInvalidHash
	}
	return params, nil
}

func decodeHashPart(encoded string, minimum, maximum int) ([]byte, error) {
	if len(encoded) < base64.RawStdEncoding.EncodedLen(minimum) ||
		len(encoded) > base64.RawStdEncoding.EncodedLen(maximum) ||
		strings.ContainsAny(encoded, "\r\n") {
		return nil, ErrInvalidHash
	}
	decoded, err := base64.RawStdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(decoded) < minimum || len(decoded) > maximum {
		return nil, ErrInvalidHash
	}
	return decoded, nil
}
