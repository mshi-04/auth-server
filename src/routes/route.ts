import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "../models/index.ts";

export interface Route {
  readonly path: string;
  readonly methods: readonly string[];
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): void | Promise<void>;
}
