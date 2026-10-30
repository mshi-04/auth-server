import type { Argon2Parameters } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rejected } from "../../../tests/support/errors.ts";
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

function holdDerivations() {
  const pending: Pending[] = [];
  const starts: (() => void)[] = [];
  restore = replaceDerivationForTesting(
    (parameters) =>
      new Promise((resolve, reject) => {
        pending.push({ parameters, resolve, reject });
        starts.shift()?.();
      }),
  );
  const nextStart = () => {
    const started = Promise.withResolvers<undefined>();
    starts.push(() => {
      started.resolve(undefined);
    });
    return started.promise;
  };
  return { pending, nextStart };
}

function take(pending: Pending[]): Pending {
  const item = pending.shift();
  if (item === undefined) {
    throw new Error("Expected a pending derivation.");
  }
  return item;
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
      const { pending, nextStart } = holdDerivations();
      const hasher = Argon2PasswordProvider.create(params);
      const controller = new AbortController();
      const started = nextStart();
      const running = operation(hasher, controller.signal);
      await started;
      expect(pending).toHaveLength(1);
      controller.abort();
      const blocked = rejected(hasher.hash(password, signal));
      await vi.advanceTimersByTimeAsync(params.waitTimeoutMs);
      expect(await blocked).toBeInstanceOf(PasswordBusyError);
      expect(pending).toHaveLength(1);
      const task = take(pending);
      task.resolve(Buffer.alloc(task.parameters.tagLength));
      await running;
      const followingStarted = nextStart();
      const next = hasher.hash(password, signal);
      await followingStarted;
      expect(pending).toHaveLength(1);
      const following = take(pending);
      following.resolve(Buffer.alloc(following.parameters.tagLength));
      await next;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(operations)(
    "%s never starts derivation for a pre-aborted request",
    async (_, operation) => {
      const { pending } = holdDerivations();
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
    const { pending, nextStart } = holdDerivations();
    const hasher = Argon2PasswordProvider.create(params);
    const controller = new AbortController();
    const running = hasher.hash(password, controller.signal);
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(PasswordBusyError);
    expect(pending).toHaveLength(0);
    const started = nextStart();
    const next = hasher.hash(password, signal);
    await started;
    expect(pending).toHaveLength(1);
    const task = take(pending);
    task.resolve(Buffer.alloc(task.parameters.tagLength));
    await next;
  });

  it.each(operations)(
    "%s releases the slot after a derivation failure",
    async (_, operation) => {
      const { pending, nextStart } = holdDerivations();
      const hasher = Argon2PasswordProvider.create(params);
      const failure = new Error("derivation failed");
      const started = nextStart();
      const followingStarted = nextStart();
      const running = rejected(operation(hasher, signal));
      const following = hasher.hash(password, signal);
      await started;
      expect(pending).toHaveLength(1);
      take(pending).reject(failure);
      expect(await running).toBe(failure);
      await followingStarted;
      expect(pending).toHaveLength(1);
      const next = take(pending);
      next.resolve(Buffer.alloc(next.parameters.tagLength));
      await following;
      expect(pending).toHaveLength(0);
    },
  );
});
