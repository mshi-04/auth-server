import { health } from "../controllers/index.ts";
import type { Route } from "./index.ts";

export function healthRoutes(): Route[] {
  return [{ path: "/healthz", methods: ["GET", "HEAD"], handle: health }];
}
