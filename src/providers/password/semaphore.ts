import { PasswordBusyError } from "../../errors/index.ts";

type Waiter = { readonly grant: () => boolean };
const maxTimerDelayMs = 2_147_483_647;

export function abortedError(signal: AbortSignal): PasswordBusyError {
  return new PasswordBusyError(undefined, { cause: signal.reason });
}

export class Semaphore {
  #active = 0;
  readonly #limit: number;
  readonly #timeoutMs: number;
  readonly #queue = new Set<Waiter>();

  private constructor(limit: number, timeoutMs: number) {
    this.#limit = limit;
    this.#timeoutMs = timeoutMs;
  }

  static create(limit: number, timeoutMs: number): Semaphore {
    return new Semaphore(limit, timeoutMs);
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(abortedError(signal));
    }
    if (this.#active < this.#limit) {
      this.#active++;
      return Promise.resolve(this.#release());
    }
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + this.#timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.#queue.delete(waiter);
      };
      const abort = () => {
        cleanup();
        reject(abortedError(signal));
      };
      const timeout = () => {
        cleanup();
        reject(new PasswordBusyError());
      };
      const waiter: Waiter = {
        grant: () => {
          if (signal.aborted) {
            abort();
            return false;
          }
          if (performance.now() >= deadline) {
            timeout();
            return false;
          }
          cleanup();
          this.#active++;
          resolve(this.#release());
          return true;
        },
      };
      const armTimeout = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          timeout();
          return;
        }
        // Node clamps larger delays to 1 ms; split long valid timeouts instead.
        timer = setTimeout(armTimeout, Math.min(remaining, maxTimerDelayMs));
      };
      this.#queue.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
      armTimeout();
    });
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#active--;
      for (const waiter of this.#queue) {
        if (waiter.grant()) {
          break;
        }
      }
    };
  }
}
