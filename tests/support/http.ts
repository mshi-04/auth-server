import { once } from "node:events";
import type { Server } from "node:http";
import type { RequestContext } from "../../src/models/index.ts";

export async function listenOnLoopback(server: Server): Promise<number> {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP listener.");
  }
  return address.port;
}

export async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server.closeAllConnections();
  await closed;
}

export function testRequestContext(
  options: {
    readonly signal?: AbortSignal;
    readonly canRespond?: boolean;
  } = {},
): RequestContext {
  const signal = options.signal ?? new AbortController().signal;
  return {
    signal,
    disconnectedSignal: signal,
    deadlineSignal: signal,
    deadline: Infinity,
    canRespond: () => options.canRespond ?? !signal.aborted,
  };
}
