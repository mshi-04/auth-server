import { describe, expect, it } from "vitest";
import { InvalidHashError } from "../../errors/index.ts";
import { EncodedHash } from "../index.ts";
import { encodeBase64 } from "./phc.ts";

const salt = encodeBase64(Buffer.alloc(16));
const key = encodeBase64(Buffer.alloc(32));
function phc(cost = "m=64,t=1,p=1", nonce = salt, tag = key): string {
  return `$argon2id$v=19$${cost}$${nonce}$${tag}`;
}

describe("PHC parsing", () => {
  it.each([
    "m=64,t=1,p=1",
    "m=64,p=1,t=1",
    "t=1,m=64,p=1",
    "t=1,p=1,m=64",
    "p=1,m=64,t=1",
    "p=1,t=1,m=64",
  ])("preserves original parameter order: %s", (cost) => {
    expect(EncodedHash.parse(phc(cost)).phc()).toBe(phc(cost));
  });

  it.each([
    ["m=8,t=1,p=1", 8, 4],
    ["m=262144,t=10,p=16", 64, 64],
    ["m=128,t=1,p=16", 8, 4],
  ])(
    "accepts independent limits: %s / %i / %i",
    (cost, saltLength, keyLength) => {
      const encoded = phc(
        cost,
        encodeBase64(Buffer.alloc(saltLength)),
        encodeBase64(Buffer.alloc(keyLength)),
      );
      expect(EncodedHash.parse(encoded).phc()).toBe(encoded);
    },
  );

  it.each([
    "",
    phc().slice(1),
    phc().replace("argon2id", "argon2i"),
    phc().replace("v=19", "v=18"),
    phc().replace("v=19", "v=19extra"),
    phc().replace("$v=19", ""),
    `${phc()}$extra`,
    `${phc()}$`,
    "$argon2id$v=19$m=64,t=1,p=1",
    `${phc()}\n`,
    ...[
      "m=64,p=1",
      "m=64,t=1,p=1,q=1",
      "m=64,m=64,p=1",
      "m=64,t=1,q=1",
      "m64,t=1,p=1",
      "m=,t=1,p=1",
      "m=64,,p=1",
      "m=0,t=1,p=1",
      "m=064,t=1,p=1",
      "m=64,t=01,p=1",
      "m=64,t=1,p=01",
      "m=15,t=1,p=2",
      "m=262145,t=1,p=1",
      "m=9007199254740992,t=1,p=1",
      "m=64,t=0,p=1",
      "m=64,t=11,p=1",
      "m=64,t=1,p=0",
      "m=64,t=1,p=17",
      "m=-64,t=1,p=1",
      "m=+64,t=1,p=1",
      "m=６４,t=1,p=1",
      "m=64,t=1.0,p=1",
      "m=64,t=1,p=1extra",
      "m=64, t=1,p=1",
      "m=64,t=1,p=1\n",
      "m=64\n,t=1,p=1",
      "m=64,t=1,p=1=2",
    ].map((cost) => phc(cost)),
    ...[
      "",
      "AA",
      `${salt}=`,
      `${salt}\n`,
      `${salt}\r`,
      "_".repeat(22),
      "!".repeat(22),
      "A".repeat(87),
      "A".repeat(25),
      "A".repeat(21) + "B",
    ].map((nonce) => phc(undefined, nonce)),
    ...[
      "",
      "AAAA",
      `${key}=`,
      `${key}\n`,
      `${key}\r`,
      "_".repeat(43),
      "!".repeat(43),
      "A".repeat(87),
      "A".repeat(9),
      "A".repeat(42) + "B",
    ].map((tag) => phc(undefined, undefined, tag)),
  ])("rejects malformed PHC %j", (encoded) => {
    expect(() => EncodedHash.parse(encoded)).toThrow(InvalidHashError);
    try {
      EncodedHash.parse(encoded);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidHashError);
      if (error instanceof Error && encoded !== "") {
        expect(error.message).not.toContain(encoded);
      }
    }
  });
});
