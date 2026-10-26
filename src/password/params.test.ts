import { describe, expect, it } from "vitest";
import { InvalidParamsError } from "../errors/index.ts";
import { defaultParams, Hasher } from "./index.ts";

describe("password provider settings", () => {
  it("returns fresh complete defaults", () => {
    const params = defaultParams();
    expect(params).toEqual({
      memoryKiB: 131072,
      iterations: 9,
      parallelism: 2,
      saltLength: 16,
      keyLength: 32,
      maxConcurrent: 4,
      waitTimeoutMs: 5000,
    });
    params.iterations = 1;
    expect(defaultParams().iterations).toBe(9);
  });

  it("validates model parameters at creation", () => {
    expect(() => Hasher.create({ ...defaultParams(), iterations: 0 })).toThrow(
      InvalidParamsError,
    );
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
  ])("creates a hasher with supported bounds %j", (patch) => {
    expect(Hasher.create({ ...defaultParams(), ...patch })).toBeInstanceOf(
      Hasher,
    );
  });
});
