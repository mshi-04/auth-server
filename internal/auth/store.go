package auth

import "context"

type UserStore interface {
	CreateUser(ctx context.Context, u NewUser) error
	FindCredentialByEmail(ctx context.Context, emailNormalized string) (Credential, error)
	UpdatePasswordHash(ctx context.Context, userID, passwordHash string) error
}

type NewUser struct {
	ID              string
	Email           string
	EmailNormalized string
	PasswordHash    string
}

type Credential struct {
	UserID       string
	PasswordHash string
}
