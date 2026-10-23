package auth

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/mail"
	"strings"
	"unicode"

	"auth-server/internal/password"

	"github.com/google/uuid"
)

type Service struct {
	store     UserStore
	hasher    *password.Hasher
	logger    *slog.Logger
	dummyHash password.EncodedHash
}

func NewService(store UserStore, hasher *password.Hasher, logger *slog.Logger) (*Service, error) {
	if store == nil || hasher == nil || logger == nil {
		return nil, errors.New("create auth service: nil dependency")
	}
	dummyPassword, err := password.ParsePassword(rand.Text())
	if err != nil {
		return nil, fmt.Errorf("parse dummy password: %w", err)
	}
	dummyHash, err := hasher.Hash(context.Background(), dummyPassword)
	if err != nil {
		return nil, fmt.Errorf("create dummy password hash: %w", err)
	}
	return &Service{store: store, hasher: hasher, logger: logger, dummyHash: dummyHash}, nil
}

func (s *Service) Register(ctx context.Context, email, rawPassword string) (string, error) {
	parsedPassword, err := password.ParsePassword(rawPassword)
	if err != nil {
		return "", fmt.Errorf("register user: %w", ErrWeakPassword)
	}
	emailAddress, err := parseEmail(email)
	if err != nil {
		return "", fmt.Errorf("register user: %w", err)
	}
	encoded, err := s.hasher.Hash(ctx, parsedPassword)
	if errors.Is(err, password.ErrPolicyViolation) {
		return "", fmt.Errorf("register user: %w", ErrWeakPassword)
	}
	if err != nil {
		return "", fmt.Errorf("hash registration password: %w", passwordError(err))
	}
	phc, err := encoded.PHC()
	if err != nil {
		return "", fmt.Errorf("read registration password hash: %w", err)
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return "", fmt.Errorf("generate user ID: %w", err)
	}
	userID := id.String()
	if err := s.store.CreateUser(ctx, NewUser{
		ID: userID, Email: emailAddress, EmailNormalized: strings.ToLower(emailAddress), PasswordHash: phc,
	}); err != nil {
		return "", fmt.Errorf("register user: %w", err)
	}
	return userID, nil
}

func (s *Service) Login(ctx context.Context, email, rawPassword string) (string, error) {
	parsedPassword, err := password.ParsePassword(rawPassword)
	if err != nil {
		return "", fmt.Errorf("login: %w", ErrInvalidCredentials)
	}
	emailNormalized, err := normalizeEmail(email)
	if err != nil {
		return "", s.rejectWithDummy(ctx, parsedPassword)
	}
	credential, err := s.store.FindCredentialByEmail(ctx, emailNormalized)
	if errors.Is(err, ErrUserNotFound) {
		return "", s.rejectWithDummy(ctx, parsedPassword)
	}
	if err != nil {
		return "", fmt.Errorf("find login credential: %w", err)
	}
	encoded, err := password.ParseEncodedHash(credential.PasswordHash)
	if err != nil {
		s.logger.ErrorContext(ctx, "invalid stored password hash", "user_id", credential.UserID, "error", err)
		return "", s.rejectWithDummy(ctx, parsedPassword)
	}
	match, err := s.hasher.Verify(ctx, parsedPassword, encoded)
	if err != nil {
		return "", fmt.Errorf("verify login password: %w", passwordError(err))
	}
	if !match {
		return "", fmt.Errorf("login: %w", ErrInvalidCredentials)
	}
	if s.hasher.NeedsRehash(encoded) {
		s.rehashCredential(ctx, credential.UserID, parsedPassword)
	}
	return credential.UserID, nil
}

func (s *Service) rejectWithDummy(ctx context.Context, parsedPassword password.Password) error {
	if _, err := s.hasher.Verify(ctx, parsedPassword, s.dummyHash); err != nil {
		return fmt.Errorf("verify dummy password: %w", passwordError(err))
	}
	return fmt.Errorf("login: %w", ErrInvalidCredentials)
}

func (s *Service) rehashCredential(ctx context.Context, userID string, parsedPassword password.Password) {
	encoded, err := s.hasher.Rehash(ctx, parsedPassword)
	if err != nil {
		s.logger.WarnContext(ctx, "rehash password failed", "user_id", userID, "error", err)
		return
	}
	phc, err := encoded.PHC()
	if err != nil {
		s.logger.WarnContext(ctx, "read rehashed password failed", "user_id", userID, "error", err)
		return
	}
	if err := s.store.UpdatePasswordHash(ctx, userID, phc); err != nil {
		s.logger.WarnContext(ctx, "save rehashed password failed", "user_id", userID, "error", err)
	}
}

func parseEmail(email string) (string, error) {
	parsed, err := mail.ParseAddress(email)
	if err != nil {
		return "", ErrInvalidEmail
	}
	trimmed := strings.TrimSpace(email)
	if trimmed != parsed.Address && trimmed != "<"+parsed.Address+">" {
		return "", ErrInvalidEmail
	}
	if strings.ContainsFunc(parsed.Address, func(r rune) bool { return r > unicode.MaxASCII }) {
		return "", ErrInvalidEmail
	}
	return parsed.Address, nil
}

func normalizeEmail(email string) (string, error) {
	address, err := parseEmail(email)
	if err != nil {
		return "", err
	}
	return strings.ToLower(address), nil
}

func passwordError(err error) error {
	if errors.Is(err, password.ErrBusy) {
		return fmt.Errorf("%w: %w", ErrBusy, err)
	}
	return err
}
