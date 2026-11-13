import type { IncomingMessage } from "node:http";
import type { AuthController } from "../controllers/index.ts";
import { readJson, validateRequest } from "../middlewares/index.ts";
import type { RequestContext } from "../models/index.ts";
import { parseCredentials } from "../schemas/index.ts";
import type { Route } from "./route.ts";

async function readCredentials(req: IncomingMessage, context: RequestContext) {
  return validateRequest(await readJson(req, context), parseCredentials);
}

export function authRoutes(controller: AuthController): Route[] {
  return [
    {
      path: "/v1/users",
      methods: ["POST"],
      async handle(req, res, context) {
        const input = await readCredentials(req, context);
        await controller.register(req, res, context, input);
      },
    },
    {
      path: "/v1/sessions",
      methods: ["POST"],
      async handle(req, res, context) {
        const input = await readCredentials(req, context);
        await controller.login(req, res, context, input);
      },
    },
  ];
}
