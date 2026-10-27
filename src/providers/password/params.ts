import type { Params } from "../../models/index.ts";

export function defaultParams(): Params {
  return {
    memoryKiB: 131072,
    iterations: 9,
    parallelism: 2,
    saltLength: 16,
    keyLength: 32,
    maxConcurrent: 4,
    waitTimeoutMs: 5000,
  };
}
