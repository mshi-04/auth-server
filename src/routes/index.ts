import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthController, WebController } from "../controllers/index.ts";
import { MethodNotAllowedError, NotFoundError } from "../errors/index.ts";
import type { RequestContext } from "../models/index.ts";
import { authRoutes } from "./auth-routes.ts";
import { healthRoutes } from "./health-routes.ts";
import { webRoutes } from "./web-routes.ts";

export interface Route {
  path: string;
  methods: readonly string[];
  handle(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext,
  ): void | Promise<void>;
}

export function createRoutes(
  authController: AuthController,
  webController: WebController,
) {
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
    const path = req.url?.split("?", 1)[0];
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
