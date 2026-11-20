import { randomBytes, timingSafeEqual } from "node:crypto";
import { PolicyViolationError } from "../../errors/index.ts";
import { validateParams } from "../../models/index.ts";
import type {
  Cost,
  EncodedHash,
  Params,
  Password,
} from "../../models/index.ts";
import {
  createHash,
  isCanonicalHash,
  readHash,
  readPassword,
} from "../../models/password/values.ts";
import type { PasswordProvider } from "../index.ts";
import { deriveKey } from "./derive.ts";
import { abortedError, Semaphore } from "./semaphore.ts";

const minPasswordCodePoints = 12;

export class Argon2PasswordProvider implements PasswordProvider {
  readonly #params: Params;
  readonly #slots: Semaphore;

  private constructor(params: Params) {
    this.#params = params;
    this.#slots = Semaphore.create(params.maxConcurrent, params.waitTimeoutMs);
  }

  static create(params: Params): Argon2PasswordProvider {
    const copy = { ...params };
    validateParams(copy);
    return new Argon2PasswordProvider(copy);
  }

  async hash(password: Password, signal: AbortSignal): Promise<EncodedHash> {
    if (readPassword(password).length < minPasswordCodePoints) {
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
    const decoded = readHash(encoded);
    const key = await this.#withSlot(signal, () =>
      derive(password, decoded.cost, decoded.salt, decoded.key.length),
    );
    return timingSafeEqual(key, decoded.key);
  }

  needsRehash(encoded: EncodedHash): boolean {
    const decoded = readHash(encoded);
    return (
      decoded.cost.memoryKiB !== this.#params.memoryKiB ||
      decoded.cost.iterations !== this.#params.iterations ||
      decoded.cost.parallelism !== this.#params.parallelism ||
      decoded.salt.length !== this.#params.saltLength ||
      decoded.key.length !== this.#params.keyLength ||
      !isCanonicalHash(encoded)
    );
  }

  #generate(password: Password, signal: AbortSignal): Promise<EncodedHash> {
    return this.#withSlot(signal, async () => {
      const { memoryKiB, iterations, parallelism, saltLength, keyLength } =
        this.#params;
      const cost = { memoryKiB, iterations, parallelism };
      const salt = randomBytes(saltLength);
      const key = await derive(password, cost, salt, keyLength);
      return createHash(cost, salt, key);
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
