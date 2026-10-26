import { InvalidParamsError } from "../../errors/index.ts";

export type Params = {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  saltLength: number;
  keyLength: number;
  maxConcurrent: number;
  waitTimeoutMs: number;
};

export type Cost = Pick<Params, "memoryKiB" | "iterations" | "parallelism">;

export function inRange(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function validCost(cost: Cost): boolean {
  return (
    inRange(cost.parallelism, 1, 16) &&
    inRange(cost.memoryKiB, 8 * cost.parallelism, 262144) &&
    inRange(cost.iterations, 1, 10)
  );
}

export function validateParams(params: Params): void {
  if (
    !validCost(params) ||
    !inRange(params.saltLength, 16, 64) ||
    !inRange(params.keyLength, 4, 64) ||
    !inRange(params.maxConcurrent, 1, Number.MAX_SAFE_INTEGER) ||
    !inRange(params.waitTimeoutMs, 1, Number.MAX_SAFE_INTEGER)
  ) {
    throw new InvalidParamsError();
  }
}
