import { defaultCost } from "../../models/index.ts";
import type { Params } from "../../models/index.ts";

export function defaultParams(): Params {
  return {
    ...defaultCost,
    saltLength: 16,
    keyLength: 32,
    maxConcurrent: 4,
    waitTimeoutMs: 5000,
  };
}
