package auth

import "errors"

var (
	ErrEmailTaken   = errors.New("email already taken")
	ErrUserNotFound = errors.New("user not found")
	ErrBusy         = errors.New("busy")
)
