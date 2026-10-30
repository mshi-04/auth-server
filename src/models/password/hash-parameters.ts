import { InvalidParamsError } from "../../errors/index.ts";

const minParallelism = 1;
const maxParallelism = 16;
const minMemoryKiBPerLane = 8;
const maxMemoryKiB = 262144;
const minIterations = 1;
const maxIterations = 10;
const minGeneratedSaltBytes = 16;
const maxSaltBytes = 64;
const minKeyBytes = 4;
const maxKeyBytes = 64;
const minPositive = 1;

export type Params = {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  saltLength: number;
  keyLength: number;
  maxConcurrent: number;
  waitTimeoutMs: number;
};

export type Cost = Readonly<
  Pick<Params, "memoryKiB" | "iterations" | "parallelism">
>;

export function isInRange(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function isValidCost(cost: Cost): boolean {
  return (
    isInRange(cost.parallelism, minParallelism, maxParallelism) &&
    isInRange(
      cost.memoryKiB,
      minMemoryKiBPerLane * cost.parallelism,
      maxMemoryKiB,
    ) &&
    isInRange(cost.iterations, minIterations, maxIterations)
  );
}

export function validateParams(params: Params): void {
  if (
    !isValidCost(params) ||
    !isInRange(params.saltLength, minGeneratedSaltBytes, maxSaltBytes) ||
    !isInRange(params.keyLength, minKeyBytes, maxKeyBytes) ||
    !isInRange(params.maxConcurrent, minPositive, Number.MAX_SAFE_INTEGER) ||
    !isInRange(params.waitTimeoutMs, minPositive, Number.MAX_SAFE_INTEGER)
  ) {
    throw new InvalidParamsError();
  }
}
