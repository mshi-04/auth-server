package password

import (
	"errors"
	"time"
)

const (
	maxMemoryKiB   = 256 * 1024
	maxIterations  = 10
	maxParallelism = 16
	minSaltLength  = 16
	maxSaltLength  = 64
	minKeyLength   = 4
	maxKeyLength   = 64
)

var ErrInvalidParams = errors.New("invalid password parameters")

type Params struct {
	MemoryKiB     uint32
	Iterations    uint32
	Parallelism   uint8
	SaltLength    uint32
	KeyLength     uint32
	MaxConcurrent int
	WaitTimeout   time.Duration
}

func DefaultParams() Params {
	return Params{
		MemoryKiB:     131072,
		Iterations:    9,
		Parallelism:   2,
		SaltLength:    16,
		KeyLength:     32,
		MaxConcurrent: 4,
		WaitTimeout:   5 * time.Second,
	}
}

func (p Params) validate() error {
	if !p.validCost() || p.SaltLength < minSaltLength || p.SaltLength > maxSaltLength ||
		p.KeyLength < minKeyLength || p.KeyLength > maxKeyLength ||
		p.MaxConcurrent <= 0 || p.WaitTimeout <= 0 {
		return ErrInvalidParams
	}
	return nil
}

func (p Params) validCost() bool {
	return p.Parallelism >= 1 && p.Parallelism <= maxParallelism &&
		p.MemoryKiB >= 8*uint32(p.Parallelism) && p.MemoryKiB <= maxMemoryKiB &&
		p.Iterations >= 1 && p.Iterations <= maxIterations
}
