import { lstat, open } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
import { throwIfAborted } from "./errors.ts";

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function requirePrivateOwnership(
  info: Pick<Stats, "uid" | "mode">,
): void {
  if (process.geteuid === undefined || info.uid !== process.geteuid()) {
    throw new Error("Sqlite database owner must match the effective user.");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(
      "Sqlite database group and other permissions must be disabled.",
    );
  }
}

async function checkDatabaseFile(path: string): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }
    throw new Error("Inspect sqlite database file failed.", { cause: error });
  }
  if (!info.isFile()) {
    throw new Error("Sqlite database and sidecars must be regular files.");
  }
  requirePrivateOwnership(info);
}

export async function prepareDatabaseFile(
  path: string,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const parent = await lstat(dirname(path));
  throwIfAborted(signal);
  if (!parent.isDirectory()) {
    throw new Error("Sqlite database parent must be a real directory.");
  }
  requirePrivateOwnership(parent);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    await checkDatabaseFile(path + suffix);
    throwIfAborted(signal);
  }

  try {
    const file = await open(path, "wx", 0o600);
    await file.close();
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throwIfAborted(signal);
      await checkDatabaseFile(path);
      return;
    }
    throw new Error("Create private sqlite database failed.", { cause: error });
  }
}
