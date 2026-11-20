import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { ConfigError, hasCode } from "../errors/index.ts";
import { defaultCost, isValidCost } from "../models/index.ts";
import type { Cost } from "../models/index.ts";

const defaultPort = 8080;
const minPort = 1;
const maxPort = 65535;

export type Config = {
  readonly databasePath: string;
  readonly port: number;
  readonly passwordCost: Cost;
};

function isWindowsDrive(path: string): boolean {
  return path === "/mnt/c" || path.startsWith("/mnt/c/");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return false;
    }
    throw new ConfigError("Inspect DATABASE_PATH failed.", { cause: error });
  }
}

function resolveDatabaseLinks(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      throw new ConfigError("Resolve DATABASE_PATH links failed.", {
        cause: error,
      });
    }
    if (pathExists(path)) {
      throw new ConfigError("DATABASE_PATH is a dangling symbolic link.", {
        cause: error,
      });
    }
  }

  try {
    return resolve(realpathSync(dirname(path)), basename(path));
  } catch (error) {
    throw new ConfigError("Resolve DATABASE_PATH parent failed.", {
      cause: error,
    });
  }
}

function parseDatabasePath(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new ConfigError("DATABASE_PATH is required.");
  }

  const path = resolve(raw);
  if (isWindowsDrive(path)) {
    throw new ConfigError("DATABASE_PATH must not be under /mnt/c.");
  }

  const resolved = resolveDatabaseLinks(path);
  if (isWindowsDrive(resolved)) {
    throw new ConfigError("DATABASE_PATH must not resolve under /mnt/c.");
  }
  return path;
}

function parseDecimal(
  raw: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (raw === undefined || raw === "") {
    return defaultValue;
  }

  if (/[^0-9]/u.test(raw)) {
    throw new ConfigError(`${name} must be decimal digits.`);
  }
  return Number(raw);
}

function parsePort(raw: string | undefined): number {
  const port = parseDecimal(raw, defaultPort, "PORT");
  if (port < minPort || port > maxPort) {
    throw new ConfigError("PORT must be decimal digits between 1 and 65535.");
  }
  return port;
}

function parsePasswordCost(env: NodeJS.ProcessEnv): Cost {
  const cost: Cost = {
    memoryKiB: parseDecimal(
      env.PASSWORD_MEMORY_KIB,
      defaultCost.memoryKiB,
      "PASSWORD_MEMORY_KIB",
    ),
    iterations: parseDecimal(
      env.PASSWORD_ITERATIONS,
      defaultCost.iterations,
      "PASSWORD_ITERATIONS",
    ),
    parallelism: parseDecimal(
      env.PASSWORD_PARALLELISM,
      defaultCost.parallelism,
      "PASSWORD_PARALLELISM",
    ),
  };
  if (!isValidCost(cost)) {
    throw new ConfigError(
      `Password cost parameters are out of range: PASSWORD_MEMORY_KIB=${String(cost.memoryKiB)}, PASSWORD_ITERATIONS=${String(cost.iterations)}, PASSWORD_PARALLELISM=${String(cost.parallelism)}. Allowed: parallelism 1-16, memory 8 x parallelism-262144 KiB, iterations 1-10.`,
    );
  }
  return cost;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databasePath: parseDatabasePath(env.DATABASE_PATH),
    port: parsePort(env.PORT),
    passwordCost: parsePasswordCost(env),
  };
}
