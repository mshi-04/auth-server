package auth

import "errors"

var (
	ErrInvalidEmail       = errors.New("invalid email address")
	ErrWeakPassword       = errors.New("weak password")
	ErrEmailTaken         = errors.New("email already taken")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrUserNotFound       = errors.New("user not found")
	ErrBusy               = errors.New("busy")
)
