import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "../models/index.ts";

export function health(
  _req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
): void {
  if (!context.canRespond()) {
    return;
  }
  res.writeHead(200);
  res.end();
}
