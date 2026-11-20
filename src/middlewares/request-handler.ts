import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "../models/index.ts";
import type { LoggerProvider } from "../providers/index.ts";
import { handleError } from "./error-handler.ts";
import { createRequestContext } from "./request-lifecycle.ts";
import { setSecurityHeaders } from "./security-headers.ts";

const responseDeadlineMs = 30_000;

export function createRequestHandler(
  route: (
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ) => Promise<void>,
  logger: LoggerProvider,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const deadline = performance.now() + responseDeadlineMs;
    setSecurityHeaders(res);
    const context = createRequestContext(res, deadline);

    async function dispatch(): Promise<void> {
      try {
        await route(req, res, context);
      } catch (error) {
        handleError(error, req, res, context, logger);
      } finally {
        context.dispose();
      }
    }

    dispatch().catch((error: unknown) => {
      if (!context.signal.aborted) {
        logger.error("request failed", { error });
      }
      res.destroy();
    });
  };
}
