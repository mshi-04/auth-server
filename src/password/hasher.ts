import { randomBytes, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";
import { deriveKey } from "./derive.ts";
import { PolicyViolationError } from "./errors.ts";
import { validateParams } from "./params.ts";
import type { Cost, Params } from "./params.ts";
import { encodeHash, parseHash } from "./phc.ts";
import type { DecodedHash } from "./phc.ts";
import { abortedError, Semaphore } from "./semaphore.ts";

type PasswordSecret = { value: string; length: number };
type HashSecret = { encoded: string; decoded: DecodedHash };
const redacted = "[REDACTED]";

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
    this.#params = params;
    this.#slots = Semaphore.create(params.maxConcurrent, params.waitTimeoutMs);
  }

  static create(params: Params): Hasher {
    const copy = { ...params };
    validateParams(copy);
    return new Hasher(copy);
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
    const { decoded } = readHash(encoded);
    const key = await this.#withSlot(signal, () =>
      derive(password, decoded.cost, decoded.salt, decoded.key.length),
    );
    return timingSafeEqual(key, decoded.key);
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

  #generate(password: Password, signal: AbortSignal): Promise<EncodedHash> {
    return this.#withSlot(signal, async () => {
      const { memoryKiB, iterations, parallelism, saltLength, keyLength } =
        this.#params;
      const cost = { memoryKiB, iterations, parallelism };
      const salt = randomBytes(saltLength);
      const key = await derive(password, cost, salt, keyLength);
      const decoded = { cost, salt, key };
      return createHash(encodeHash(decoded), decoded);
    });
  }

  async #withSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const release = await this.#slots.acquire(signal);
    try {
      if (signal.aborted) {
        throw abortedError(signal);
      }
      return await run();
    } finally {
      release();
    }
  }
}

function derive(
  password: Password,
  cost: Cost,
  salt: Buffer,
  tagLength: number,
): Promise<Buffer> {
  return deriveKey({
    message: readPassword(password).value,
    nonce: salt,
    memory: cost.memoryKiB,
    passes: cost.iterations,
    parallelism: cost.parallelism,
    tagLength,
  });
}
