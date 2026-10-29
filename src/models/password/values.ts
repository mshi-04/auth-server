import { inspect } from "node:util";
import { PolicyViolationError } from "../../errors/index.ts";
import type { Cost } from "./hash-parameters.ts";
import { encodeHash, parseHash } from "./phc.ts";
import type { DecodedHash } from "./phc.ts";

type PasswordSecret = { readonly value: string; readonly length: number };
type HashSecret = { readonly encoded: string; readonly decoded: DecodedHash };
const redacted = "[REDACTED]";
const maxPasswordCodePoints = 128;

let readPasswordSecret: (password: Password) => PasswordSecret;
let readHashSecret: (encoded: EncodedHash) => HashSecret;
let createEncodedHash: (encoded: string, decoded: DecodedHash) => EncodedHash;

export class Password {
  readonly #secret: PasswordSecret;

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
    while (codePoints.next().done !== true) {
      length++;
      if (length > maxPasswordCodePoints) {
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
  readonly #secret: HashSecret;

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

function copyDecodedHash(decoded: DecodedHash): DecodedHash {
  return {
    cost: { ...decoded.cost },
    salt: Buffer.from(decoded.salt),
    key: Buffer.from(decoded.key),
  };
}

export function readPassword(password: Password): PasswordSecret {
  return { ...readPasswordSecret(password) };
}

export function readHash(encoded: EncodedHash): DecodedHash {
  return copyDecodedHash(readHashSecret(encoded).decoded);
}

export function createHash(cost: Cost, salt: Buffer, key: Buffer): EncodedHash {
  const decoded = copyDecodedHash({ cost, salt, key });
  return createEncodedHash(encodeHash(decoded), decoded);
}

export function isCanonicalHash(encoded: EncodedHash): boolean {
  const secret = readHashSecret(encoded);
  return encodeHash(secret.decoded) === secret.encoded;
}
