import type { AuthController } from "../controllers/index.ts";
import { readJson, validateRequest } from "../middlewares/index.ts";
import { parseCredentials } from "../schemas/index.ts";
import type { Route } from "./index.ts";

export function authRoutes(controller: AuthController): Route[] {
  return [
    {
      path: "/v1/users",
      methods: ["POST"],
      async handle(req, res, context) {
        const input = validateRequest(
          await readJson(req, context),
          parseCredentials,
        );
        await controller.register(req, res, context, input);
      },
    },
    {
      path: "/v1/sessions",
      methods: ["POST"],
      async handle(req, res, context) {
        const input = validateRequest(
          await readJson(req, context),
          parseCredentials,
        );
        await controller.login(req, res, context, input);
      },
    },
  ];
}
