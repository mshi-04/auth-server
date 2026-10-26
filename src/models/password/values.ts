import { inspect } from "node:util";
import { PolicyViolationError } from "../../errors/index.ts";
import type { Cost } from "./hash-parameters.ts";
import { encodeHash, parseHash } from "./phc.ts";
import type { DecodedHash } from "./phc.ts";

type PasswordSecret = { value: string; length: number };
type HashSecret = { encoded: string; decoded: DecodedHash };
const redacted = "[REDACTED]";

let readPasswordSecret: (password: Password) => PasswordSecret;
let readHashSecret: (encoded: EncodedHash) => HashSecret;
let createEncodedHash: (encoded: string, decoded: DecodedHash) => EncodedHash;

export class Password {
  #secret: PasswordSecret;

  private constructor(secret: PasswordSecret) {
    this.#secret = secret;
  }

  static {
    readPasswordSecret = (password) => password.#secret;
  }

  static parse(raw: string): Password {
    if (!raw.isWellFormed()) {
      throw new PolicyViolationError();
    }
    const value = raw.normalize("NFKC");
    const codePoints = value[Symbol.iterator]();
    let length = 0;
    while (!codePoints.next().done) {
      length++;
      if (length > 128) {
        throw new PolicyViolationError();
      }
    }
    return new Password({ value, length });
  }

  toString(): string {
    return redacted;
  }

  toJSON(): string {
    return redacted;
  }

  [inspect.custom](): string {
    return redacted;
  }
}

export class EncodedHash {
  #secret: HashSecret;

  private constructor(secret: HashSecret) {
    this.#secret = secret;
  }

  static {
    readHashSecret = (encoded) => encoded.#secret;
    createEncodedHash = (encoded, decoded) =>
      new EncodedHash({ encoded, decoded });
  }

  static parse(encoded: string): EncodedHash {
    return new EncodedHash({ encoded, decoded: parseHash(encoded) });
  }

  phc(): string {
    return this.#secret.encoded;
  }

  toString(): string {
    return redacted;
  }

  toJSON(): string {
    return redacted;
  }

  [inspect.custom](): string {
    return redacted;
  }
}

export function readPassword(password: Password): PasswordSecret {
  return readPasswordSecret(password);
}

export function readHash(encoded: EncodedHash): DecodedHash {
  return readHashSecret(encoded).decoded;
}

export function createHash(cost: Cost, salt: Buffer, key: Buffer): EncodedHash {
  const decoded = { cost, salt, key };
  return createEncodedHash(encodeHash(decoded), decoded);
}

export function isCanonicalHash(encoded: EncodedHash): boolean {
  const secret = readHashSecret(encoded);
  return encodeHash(secret.decoded) === secret.encoded;
}
