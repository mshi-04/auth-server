import type { Argon2Parameters } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordBusyError } from "../../errors/index.ts";
import { EncodedHash, Password } from "../../models/index.ts";
import { replaceDerivationForTesting } from "./derive.ts";
import { defaultParams, Argon2PasswordProvider } from "./index.ts";

const password = Password.parse("correct horse battery staple");
const signal = new AbortController().signal;
const params = {
  ...defaultParams(),
  memoryKiB: 64,
  iterations: 1,
  parallelism: 1,
  maxConcurrent: 1,
};
const fixture = EncodedHash.parse(
  "$argon2id$v=19$m=64,t=1,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
);
type Pending = {
  parameters: Argon2Parameters;
  resolve: (key: Buffer) => void;
  reject: (error: Error) => void;
};
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.useRealTimers();
});

function holdDerivations(): Pending[] {
  const pending: Pending[] = [];
  restore = replaceDerivationForTesting(
    (parameters) =>
      new Promise((resolve, reject) => {
        pending.push({ parameters, resolve, reject });
      }),
  );
  return pending;
}

function take(pending: Pending[]): Pending {
  const item = pending.shift();
  if (item === undefined) {
    throw new Error("Expected a pending derivation.");
  }
  return item;
}

async function waitForPending(
  pending: Pending[],
  count: number,
): Promise<void> {
  for (let turn = 0; turn < 100 && pending.length < count; turn++) {
    await Promise.resolve();
  }
  expect(pending).toHaveLength(count);
}

describe("hasher slot ownership", () => {
  const operations: [
    string,
    (
      hasher: Argon2PasswordProvider,
      abortSignal: AbortSignal,
    ) => Promise<unknown>,
  ][] = [
    ["hash", (hasher, abortSignal) => hasher.hash(password, abortSignal)],
    ["rehash", (hasher, abortSignal) => hasher.rehash(password, abortSignal)],
    [
      "verify",
      (hasher, abortSignal) => hasher.verify(password, fixture, abortSignal),
    ],
  ];

  it.each(operations)(
    "%s keeps its slot until derivation completes, including after abort",
    async (_, operation) => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "performance"],
      });
      const pending = holdDerivations();
      const hasher = Argon2PasswordProvider.create(params);
      const controller = new AbortController();
      const running = operation(hasher, controller.signal);
      await waitForPending(pending, 1);
      controller.abort();
      const blocked = hasher
        .hash(password, signal)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(params.waitTimeoutMs);
      expect(await blocked).toBeInstanceOf(PasswordBusyError);
      expect(pending).toHaveLength(1);
      const task = take(pending);
      task.resolve(Buffer.alloc(task.parameters.tagLength));
      await running;
      const next = hasher.hash(password, signal);
      await waitForPending(pending, 1);
      const following = take(pending);
      following.resolve(Buffer.alloc(following.parameters.tagLength));
      await next;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(operations)(
    "%s never starts derivation for a pre-aborted request",
    async (_, operation) => {
      const pending = holdDerivations();
      const controller = new AbortController();
      const reason = new Error("closed");
      controller.abort(reason);
      await expect(
        operation(Argon2PasswordProvider.create(params), controller.signal),
      ).rejects.toMatchObject({ name: "PasswordBusyError", cause: reason });
      expect(pending).toHaveLength(0);
    },
  );

  it("handles abort between immediate acquisition and continuation", async () => {
    const pending = holdDerivations();
    const hasher = Argon2PasswordProvider.create(params);
    const controller = new AbortController();
    const running = hasher.hash(password, controller.signal);
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(PasswordBusyError);
    expect(pending).toHaveLength(0);
    const next = hasher.hash(password, signal);
    await waitForPending(pending, 1);
    const task = take(pending);
    task.resolve(Buffer.alloc(task.parameters.tagLength));
    await next;
  });

  it.each(operations)(
    "%s releases the slot after a derivation failure",
    async (_, operation) => {
      const pending = holdDerivations();
      const hasher = Argon2PasswordProvider.create(params);
      const failure = new Error("derivation failed");
      const running = operation(hasher, signal).catch(
        (error: unknown) => error,
      );
      const following = hasher.hash(password, signal);
      await waitForPending(pending, 1);
      take(pending).reject(failure);
      expect(await running).toBe(failure);
      await waitForPending(pending, 1);
      const next = take(pending);
      next.resolve(Buffer.alloc(next.parameters.tagLength));
      await following;
      expect(pending).toHaveLength(0);
    },
  );
});
