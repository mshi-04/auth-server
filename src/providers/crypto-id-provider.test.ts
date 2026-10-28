import { describe, expect, it } from "vitest";
import { Password } from "../models/index.ts";
import { CryptoIdProvider } from "./crypto-id-provider.ts";
import type { IdProvider } from "./index.ts";

describe("CryptoIdProvider", () => {
  const provider: IdProvider = CryptoIdProvider.create();

  it("generates UUID v4 identifiers", () => {
    const ids = Array.from({ length: 32 }, () => provider.newUserId());
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("generates fresh random dummy passwords within the registration policy", () => {
    const passwords = Array.from({ length: 32 }, () =>
      provider.newDummyPassword(),
    );
    for (const rawPassword of passwords) {
      expect(rawPassword).toMatch(/^[0-9a-f]{64}$/);
      expect(rawPassword.length).toBeGreaterThanOrEqual(12);
      expect(rawPassword.length).toBeLessThanOrEqual(128);
      expect(Password.parse(rawPassword)).toBeInstanceOf(Password);
    }
    expect(new Set(passwords).size).toBe(passwords.length);
  });
});
