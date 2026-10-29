import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthController, WebController } from "../controllers/index.ts";
import { MethodNotAllowedError, NotFoundError } from "../errors/index.ts";
import type { RequestContext } from "../models/index.ts";
import { authRoutes } from "./auth-routes.ts";
import { healthRoutes } from "./health-routes.ts";
import { webRoutes } from "./web-routes.ts";

export interface Route {
  readonly path: string;
  readonly methods: readonly string[];
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): void | Promise<void>;
}

function requestPath(target: string | undefined): string | undefined {
  const path = target?.split("?", 1)[0];
  const absoluteForm = path?.match(/^https?:\/\/[^/]*(\/.*)?$/iu);
  if (absoluteForm === null || absoluteForm === undefined) {
    return path;
  }
  return absoluteForm[1] ?? "/";
}

export function createRoutes(
  authController: AuthController,
  webController: WebController,
): (
  req: IncomingMessage,
  res: ServerResponse,
  context: RequestContext,
) => Promise<void> {
  const routes = [
    ...authRoutes(authController),
    ...healthRoutes(),
    ...webRoutes(webController),
  ];
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): Promise<void> => {
    const path = requestPath(req.url);
    const route = routes.find((candidate) => candidate.path === path);
    if (route === undefined) {
      throw new NotFoundError();
    }
    if (req.method === undefined || !route.methods.includes(req.method)) {
      throw new MethodNotAllowedError(route.methods);
    }
    await route.handle(req, res, context);
  };
}
