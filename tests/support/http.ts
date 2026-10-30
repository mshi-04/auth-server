import { once } from "node:events";
import type { Server } from "node:http";

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
