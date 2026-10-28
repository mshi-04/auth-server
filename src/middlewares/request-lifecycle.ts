import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "../models/index.ts";

class RequestLifecycle implements RequestContext {
  #response: ServerResponse;
  #deadline: number;
  #disconnected = new AbortController();
  #expired = new AbortController();
  #signal: AbortSignal;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  private constructor(response: ServerResponse, deadline: number) {
    this.#response = response;
    this.#deadline = deadline;
    this.#signal = AbortSignal.any([
      this.#disconnected.signal,
      this.#expired.signal,
    ]);
  }

  static create(response: ServerResponse, deadline: number): RequestLifecycle {
    const lifecycle = new RequestLifecycle(response, deadline);
    response.once("close", lifecycle.#onClose);
    response.once("finish", lifecycle.#cleanup);
    response.once("error", lifecycle.#onError);
    if (response.destroyed) {
      lifecycle.#onClose();
      return lifecycle;
    }
    if (response.writableFinished) {
      lifecycle.#cleanup();
      return lifecycle;
    }
    lifecycle.#armDeadline();
    return lifecycle;
  }

  get signal(): AbortSignal {
    return this.#signal;
  }

  get disconnectedSignal(): AbortSignal {
    return this.#disconnected.signal;
  }

  get deadlineSignal(): AbortSignal {
    return this.#expired.signal;
  }

  get deadline(): number {
    return this.#deadline;
  }

  canRespond(): boolean {
    if (
      !this.#disposed &&
      !this.#signal.aborted &&
      performance.now() >= this.#deadline
    ) {
      this.#expire();
    }
    return (
      !this.#disposed &&
      !this.#signal.aborted &&
      !this.#response.destroyed &&
      !this.#response.writableEnded &&
      !this.#response.writableFinished
    );
  }

  dispose(): void {
    if (
      this.#response.writableEnded &&
      !this.#response.writableFinished &&
      !this.#response.destroyed
    ) {
      return;
    }
    this.#cleanup();
  }

  #onClose = (): void => {
    if (!this.#response.writableFinished && !this.#expired.signal.aborted) {
      this.#disconnected.abort(new Error("Client connection closed."));
    }
    this.#cleanup();
  };

  #onError = (): void => {
    this.#onClose();
    this.#response.destroy();
  };

  #cleanup = (): void => {
    clearTimeout(this.#timer);
    this.#response.removeListener("close", this.#onClose);
    this.#response.removeListener("finish", this.#cleanup);
    this.#response.removeListener("error", this.#onError);
    this.#disposed = true;
  };

  #expire(): void {
    this.#expired.abort(new Error("Response deadline exceeded."));
    this.#response.destroy();
    this.#cleanup();
  }

  #armDeadline(): void {
    const remaining = this.#deadline - performance.now();
    if (remaining <= 0) {
      this.#expire();
      return;
    }
    this.#timer = setTimeout(
      () => {
        this.#armDeadline();
      },
      Math.min(remaining, 2147483647),
    );
  }
}

export function createRequestContext(
  _request: IncomingMessage,
  response: ServerResponse,
  deadline: number,
): RequestContext & { dispose(): void } {
  return RequestLifecycle.create(response, deadline);
}
