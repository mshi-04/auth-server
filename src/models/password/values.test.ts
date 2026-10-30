import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { caught } from "../../../tests/support/errors.ts";
import { PolicyViolationError } from "../../errors/index.ts";
import { EncodedHash, Password } from "../index.ts";
import { createHash, readHash, readPassword } from "./values.ts";

describe("password values", () => {
  it.each([
    "",
    "short",
    "a".repeat(11),
    "a".repeat(12),
    "a".repeat(128),
    "😀".repeat(128),
    "㍿".repeat(32),
    "e\u0301".repeat(128),
  ])("parses valid well-formed input %j", (raw) => {
    expect(Password.parse(raw)).toBeInstanceOf(Password);
  });

  it.each([
    "a".repeat(129),
    "😀".repeat(129),
    "㍿".repeat(33),
    "\ud800",
    "\udfff",
    "a\ud800b",
  ])("rejects malformed or long input %j", (raw) => {
    const error = caught(() => Password.parse(raw));
    expect(error).toBeInstanceOf(PolicyViolationError);
    if (error instanceof Error) {
      expect(error.message).not.toContain(raw);
    }
  });

  it("redacts both value objects through all normal output paths", () => {
    const raw = "correct horse battery staple";
    const password = Password.parse(raw);
    const parsed = EncodedHash.parse(
      "$argon2id$v=19$m=64,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    const generated = createHash(
      { memoryKiB: 64, iterations: 1, parallelism: 1 },
      Buffer.alloc(16),
      Buffer.alloc(32),
    );
    for (const value of [password, parsed, generated]) {
      expect(value.toString()).toBe("[REDACTED]");
      expect(value.toJSON()).toBe("[REDACTED]");
      expect(JSON.stringify(value)).toBe('"[REDACTED]"');
      expect(inspect(value)).toBe("[REDACTED]");
      expect(inspect({ value })).toBe("{ value: [REDACTED] }");
      expect(JSON.stringify({ value })).toBe('{"value":"[REDACTED]"}');
      expect(format("%s", value)).toBe("[REDACTED]");
      expect(format("%o", value)).toBe("[REDACTED]");
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Exercise implicit interpolation of secret value objects.
      expect(`${value}`).toBe("[REDACTED]");
      expect(Object.keys(value)).toEqual([]);
    }
    for (const encoded of [parsed, generated]) {
      expect(inspect({ encoded })).not.toContain(encoded.phc());
    }
    expect(inspect({ password })).not.toContain(raw);
  });

  it("isolates internal state from external mutations", () => {
    const password = Password.parse("correct horse battery staple");
    expect(readPassword(password)).not.toBe(readPassword(password));

    const salt = Buffer.alloc(16, 1);
    const key = Buffer.alloc(32, 2);
    const cost = { memoryKiB: 64, iterations: 1, parallelism: 1 };
    const hash = createHash(cost, salt, key);
    cost.memoryKiB = 128;
    salt.fill(9);
    key.fill(8);

    const firstRead = readHash(hash);
    expect(firstRead.cost).toEqual({
      memoryKiB: 64,
      iterations: 1,
      parallelism: 1,
    });
    expect(firstRead.salt.equals(Buffer.alloc(16, 1))).toBe(true);
    expect(firstRead.key.equals(Buffer.alloc(32, 2))).toBe(true);

    Object.assign(firstRead.cost, { memoryKiB: 256 });
    firstRead.salt.fill(7);
    firstRead.key.fill(6);

    const secondRead = readHash(hash);
    expect(secondRead.cost).toEqual({
      memoryKiB: 64,
      iterations: 1,
      parallelism: 1,
    });
    expect(secondRead.salt.equals(Buffer.alloc(16, 1))).toBe(true);
    expect(secondRead.key.equals(Buffer.alloc(32, 2))).toBe(true);
  });
});
