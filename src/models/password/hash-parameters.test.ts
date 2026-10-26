import { describe, expect, it } from "vitest";
import { InvalidParamsError } from "../../errors/index.ts";
import { validateParams } from "./hash-parameters.ts";
import type { Params } from "./hash-parameters.ts";

function validParams(): Params {
  return {
    memoryKiB: 131072,
    iterations: 9,
    parallelism: 2,
    saltLength: 16,
    keyLength: 32,
    maxConcurrent: 4,
    waitTimeoutMs: 5000,
  };
}

describe("password parameters", () => {
  const fields: (keyof Params)[] = [
    "memoryKiB",
    "iterations",
    "parallelism",
    "saltLength",
    "keyLength",
    "maxConcurrent",
    "waitTimeoutMs",
  ];
  for (const field of fields) {
    it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      `rejects ${field} = %s`,
      (value) => {
        expect(() => {
          validateParams({ ...validParams(), [field]: value });
        }).toThrow(InvalidParamsError);
      },
    );
  }

  it.each([
    { memoryKiB: 15 },
    { memoryKiB: 262145 },
    { iterations: 11 },
    { parallelism: 17 },
    { saltLength: 15 },
    { saltLength: 65 },
    { keyLength: 3 },
    { keyLength: 65 },
  ])("rejects fixed-limit violation %j", (patch) => {
    expect(() => {
      validateParams({ ...validParams(), ...patch });
    }).toThrow(InvalidParamsError);
  });

  it.each([
    {
      memoryKiB: 8,
      parallelism: 1,
      iterations: 1,
      saltLength: 16,
      keyLength: 4,
    },
    {
      memoryKiB: 262144,
      parallelism: 16,
      iterations: 10,
      saltLength: 64,
      keyLength: 64,
    },
    {
      maxConcurrent: Number.MAX_SAFE_INTEGER,
      waitTimeoutMs: Number.MAX_SAFE_INTEGER,
    },
  ])("accepts supported bounds %j", (patch) => {
    expect(() => {
      validateParams({ ...validParams(), ...patch });
    }).not.toThrow();
  });
});
