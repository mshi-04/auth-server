import type { WebController } from "../controllers/index.ts";
import type { Route } from "./index.ts";

export function webRoutes(controller: WebController): Route[] {
  return [
    {
      path: "/",
      methods: ["GET", "HEAD"],
      handle: (req, res, context) => {
        controller.index(req, res, context);
      },
    },
    {
      path: "/assets/app.css",
      methods: ["GET", "HEAD"],
      handle: (req, res, context) => {
        controller.css(req, res, context);
      },
    },
    {
      path: "/assets/app.js",
      methods: ["GET", "HEAD"],
      handle: (req, res, context) => {
        controller.javascript(req, res, context);
      },
    },
  ];
}
