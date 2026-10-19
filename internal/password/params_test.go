package password

import (
	"errors"
	"testing"
	"time"
)

func TestDefaultParams(t *testing.T) {
	want := Params{
		MemoryKiB:     131072,
		Iterations:    9,
		Parallelism:   2,
		SaltLength:    16,
		KeyLength:     32,
		MaxConcurrent: 4,
		WaitTimeout:   5 * time.Second,
	}
	if got := DefaultParams(); got != want {
		t.Fatalf("DefaultParams() = %+v, want %+v", got, want)
	}
}

func TestParamsValidateAcceptsBounds(t *testing.T) {
	tests := []struct {
		name   string
		params Params
	}{
		{"defaults", DefaultParams()},
		{"minimum", Params{8, 1, 1, 16, 4, 1, time.Nanosecond}},
		{"maximum_hash_parameters", Params{262144, 10, 16, 64, 64, 4, time.Second}},
		{"memory_relative_to_parallelism", Params{128, 1, 16, 16, 32, 1, time.Second}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.params.validate(); err != nil {
				t.Fatalf("valid parameters rejected: %v", err)
			}
		})
	}
}

func TestParamsValidateRejectsInvalidValues(t *testing.T) {
	tests := []struct {
		name   string
		change func(*Params)
	}{
		{"zero_value", func(p *Params) { *p = Params{} }},
		{"memory_zero", func(p *Params) { p.MemoryKiB = 0 }},
		{"memory_below_lanes", func(p *Params) { p.MemoryKiB = 15 }},
		{"memory_over_limit", func(p *Params) { p.MemoryKiB = 262145 }},
		{"iterations_zero", func(p *Params) { p.Iterations = 0 }},
		{"iterations_over_limit", func(p *Params) { p.Iterations = 11 }},
		{"parallelism_zero", func(p *Params) { p.Parallelism = 0 }},
		{"parallelism_over_limit", func(p *Params) { p.Parallelism = 17 }},
		{"salt_empty", func(p *Params) { p.SaltLength = 0 }},
		{"salt_below_minimum", func(p *Params) { p.SaltLength = 15 }},
		{"salt_over_limit", func(p *Params) { p.SaltLength = 65 }},
		{"key_empty", func(p *Params) { p.KeyLength = 0 }},
		{"key_too_short", func(p *Params) { p.KeyLength = 3 }},
		{"key_over_limit", func(p *Params) { p.KeyLength = 65 }},
		{"concurrency_zero", func(p *Params) { p.MaxConcurrent = 0 }},
		{"concurrency_negative", func(p *Params) { p.MaxConcurrent = -1 }},
		{"timeout_zero", func(p *Params) { p.WaitTimeout = 0 }},
		{"timeout_negative", func(p *Params) { p.WaitTimeout = -time.Second }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := DefaultParams()
			tt.change(&params)
			if err := params.validate(); !errors.Is(err, ErrInvalidParams) {
				t.Fatalf("invalid parameters: got error %v, want ErrInvalidParams", err)
			}
		})
	}
}
