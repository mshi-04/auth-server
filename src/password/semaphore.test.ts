import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordBusyError } from "../errors/index.ts";
import { Semaphore } from "./semaphore.ts";

const freeSignal = new AbortController().signal;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("semaphore waiting", () => {
  it("releases in FIFO order and ignores duplicate releases", async () => {
    const semaphore = Semaphore.create(1, 5000);
    const first = await semaphore.acquire(freeSignal);
    const order: string[] = [];
    const second = semaphore.acquire(freeSignal).then((release) => {
      order.push("second");
      return release;
    });
    const third = semaphore.acquire(freeSignal).then((release) => {
      order.push("third");
      return release;
    });
    first();
    first();
    const releaseSecond = await second;
    expect(order).toEqual(["second"]);
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(["second", "third"]);
    releaseThird();
    (await semaphore.acquire(freeSignal))();
  });

  it("times out exactly and permits reuse", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const semaphore = Semaphore.create(1, 5000);
    const release = await semaphore.acquire(freeSignal);
    let failure: unknown;
    const waiting = semaphore.acquire(freeSignal).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(failure).toBeInstanceOf(PasswordBusyError);
    if (failure instanceof Error) {
      expect(failure.cause).toBeUndefined();
    }
    release();
    (await semaphore.acquire(freeSignal))();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "rejects pre-aborted signal when occupied = %s",
    async (occupied) => {
      const semaphore = Semaphore.create(1, 5000);
      const release = occupied ? await semaphore.acquire(freeSignal) : () => {};
      const controller = new AbortController();
      const reason = new Error("request ended");
      controller.abort(reason);
      await expect(semaphore.acquire(controller.signal)).rejects.toMatchObject({
        name: "PasswordBusyError",
        cause: reason,
      });
      release();
      (await semaphore.acquire(freeSignal))();
    },
  );

  it("removes aborted waiter and passes the next available slot onward", async () => {
    vi.useFakeTimers();
    const semaphore = Semaphore.create(1, 5000);
    const release = await semaphore.acquire(freeSignal);
    const controller = new AbortController();
    const reason = new Error("deadline");
    const canceled = semaphore
      .acquire(controller.signal)
      .catch((error: unknown) => error);
    const next = semaphore.acquire(freeSignal);
    controller.abort(reason);
    expect(await canceled).toMatchObject({
      name: "PasswordBusyError",
      cause: reason,
    });
    release();
    (await next)();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks deadlines on handoff even before the timer callback runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const semaphore = Semaphore.create(1, 1);
    const release = await semaphore.acquire(freeSignal);
    const failure = semaphore
      .acquire(freeSignal)
      .catch((error: unknown) => error);
    vi.spyOn(performance, "now").mockReturnValue(2);
    release();
    expect(await failure).toBeInstanceOf(PasswordBusyError);
    (await semaphore.acquire(freeSignal))();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("splits delays longer than Node's timer limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const semaphore = Semaphore.create(1, 2147483648);
    const release = await semaphore.acquire(freeSignal);
    let timedOut = false;
    const waiting = semaphore.acquire(freeSignal).catch(() => {
      timedOut = true;
    });
    await vi.advanceTimersByTimeAsync(2147483647);
    expect(timedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(timedOut).toBe(true);
    release();
    expect(vi.getTimerCount()).toBe(0);
  });
});
