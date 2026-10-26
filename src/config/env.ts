import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { ConfigError } from "../errors/index.ts";

export type Config = {
  databasePath: string;
  port: number;
};

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isWindowsDrive(path: string): boolean {
  return path === "/mnt/c" || path.startsWith("/mnt/c/");
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

    try {
      lstatSync(path);
    } catch (statError) {
      if (!hasCode(statError, "ENOENT")) {
        throw new ConfigError("Inspect DATABASE_PATH failed.", {
          cause: statError,
        });
      }

      try {
        return resolve(realpathSync(dirname(path)), basename(path));
      } catch (parentError) {
        throw new ConfigError("Resolve DATABASE_PATH parent failed.", {
          cause: parentError,
        });
      }
    }

    throw new ConfigError("Resolve DATABASE_PATH links failed.", {
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

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return 8080;
  }

  const port = Number(raw);
  if (
    /[^0-9]/u.test(raw) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new ConfigError("PORT must be decimal digits between 1 and 65535.");
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databasePath: parseDatabasePath(env.DATABASE_PATH),
    port: parsePort(env.PORT),
  };
}
