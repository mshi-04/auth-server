import type { IncomingMessage } from "node:http";
import { BadRequestError, PayloadTooLargeError } from "../errors/index.ts";
import type { RequestContext } from "../models/index.ts";

const maxBodyBytes = 16 * 1024;

function drainRequest(req: IncomingMessage): void {
  if (req.destroyed || req.readableEnded) {
    return;
  }
  function ignoreError(): void {}
  function cleanup(): void {
    req.off("error", ignoreError);
    req.off("end", cleanup);
    req.off("close", cleanup);
  }
  req.on("error", ignoreError);
  req.once("end", cleanup);
  req.once("close", cleanup);
  req.resume();
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    function cleanup(): void {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      signal.removeEventListener("abort", onAbort);
    }

    function fail(error: unknown): void {
      cleanup();
      drainRequest(req);
      reject(
        error instanceof Error
          ? error
          : new Error("Read request body failed.", { cause: error }),
      );
    }

    function onData(chunk: unknown): void {
      if (!Buffer.isBuffer(chunk)) {
        fail(new BadRequestError("read-failed"));
        return;
      }
      size += chunk.length;
      if (size > maxBodyBytes) {
        fail(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    }

    function onEnd(): void {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    }

    function onError(): void {
      fail(new BadRequestError("read-failed"));
    }

    function onAborted(): void {
      fail(new BadRequestError("read-failed"));
    }

    function onAbort(): void {
      fail(signal.reason);
    }

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    if (req.readableEnded) {
      onEnd();
      return;
    }
    if (req.destroyed) {
      onAborted();
    }
  });
}

export async function readJson(
  req: IncomingMessage,
  context: RequestContext,
): Promise<unknown> {
  context.signal.throwIfAborted();
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > maxBodyBytes) {
    drainRequest(req);
    throw new PayloadTooLargeError();
  }

  const body = await readBody(req, context.signal);
  context.signal.throwIfAborted();
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: false }).decode(body),
    );
    return parsed;
  } catch {
    throw new BadRequestError("invalid-input");
  }
}
