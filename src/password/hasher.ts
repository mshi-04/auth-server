import { randomBytes, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";
import { deriveKey } from "./derive.ts";
import { BusyError, PolicyViolationError } from "./errors.ts";
import { validateParams } from "./params.ts";
import type { Params } from "./params.ts";
import { encodeHash, parseHash } from "./phc.ts";
import type { DecodedHash } from "./phc.ts";
import { Semaphore } from "./semaphore.ts";

type PasswordSecret = { value: string; length: number };
type HashSecret = { encoded: string; decoded: DecodedHash };
const redacted = "[REDACTED]";

// Class static blocks share private fields within this module without public secret getters.
let readPassword: (password: Password) => PasswordSecret;
let readHash: (encoded: EncodedHash) => HashSecret;
let createHash: (encoded: string, decoded: DecodedHash) => EncodedHash;

export class Password {
  #secret: PasswordSecret;

  private constructor(secret: PasswordSecret) {
    this.#secret = secret;
  }

  static {
    readPassword = (password) => password.#secret;
  }

  static parse(raw: string): Password {
    if (!raw.isWellFormed()) {
      throw new PolicyViolationError();
    }
    const value = raw.normalize("NFKC");
    let length = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Count iterator elements rather than UTF-16 code units.
    for (const codePoint of value) {
      length++;
    }
    if (length > 128) {
      throw new PolicyViolationError();
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
    readHash = (encoded) => encoded.#secret;
    createHash = (encoded, decoded) => new EncodedHash({ encoded, decoded });
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

export class Hasher {
  #params: Params;
  #slots: Semaphore;

  private constructor(params: Params) {
    this.#params = { ...params };
    this.#slots = Semaphore.create(params.maxConcurrent, params.waitTimeoutMs);
  }

  static create(params: Params): Hasher {
    validateParams(params);
    return new Hasher(params);
  }

  async hash(password: Password, signal: AbortSignal): Promise<EncodedHash> {
    if (readPassword(password).length < 12) {
      throw new PolicyViolationError();
    }
    return this.#generate(password, signal);
  }

  rehash(password: Password, signal: AbortSignal): Promise<EncodedHash> {
    return this.#generate(password, signal);
  }

  async verify(
    password: Password,
    encoded: EncodedHash,
    signal: AbortSignal,
  ): Promise<boolean> {
    const release = await this.#slots.acquire(signal);
    try {
      checkSignal(signal);
      const { decoded } = readHash(encoded);
      const key = await deriveKey({
        message: readPassword(password).value,
        nonce: decoded.salt,
        memory: decoded.cost.memoryKiB,
        passes: decoded.cost.iterations,
        parallelism: decoded.cost.parallelism,
        tagLength: decoded.key.length,
      });
      return timingSafeEqual(key, decoded.key);
    } finally {
      release();
    }
  }

  needsRehash(encoded: EncodedHash): boolean {
    const { decoded, encoded: original } = readHash(encoded);
    return (
      decoded.cost.memoryKiB !== this.#params.memoryKiB ||
      decoded.cost.iterations !== this.#params.iterations ||
      decoded.cost.parallelism !== this.#params.parallelism ||
      decoded.salt.length !== this.#params.saltLength ||
      decoded.key.length !== this.#params.keyLength ||
      encodeHash(decoded) !== original
    );
  }

  async #generate(
    password: Password,
    signal: AbortSignal,
  ): Promise<EncodedHash> {
    const release = await this.#slots.acquire(signal);
    try {
      checkSignal(signal);
      const salt = randomBytes(this.#params.saltLength);
      const cost = {
        memoryKiB: this.#params.memoryKiB,
        iterations: this.#params.iterations,
        parallelism: this.#params.parallelism,
      };
      const key = await deriveKey({
        message: readPassword(password).value,
        nonce: salt,
        memory: cost.memoryKiB,
        passes: cost.iterations,
        parallelism: cost.parallelism,
        tagLength: this.#params.keyLength,
      });
      const decoded = { cost, salt, key };
      return createHash(encodeHash(decoded), decoded);
    } finally {
      release();
    }
  }
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BusyError(undefined, { cause: signal.reason });
  }
}
