import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Database } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BusyError, findError } from "../../errors/index.ts";
import { SqliteStore } from "./index.ts";

const directories: string[] = [];
const stores: SqliteStore[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryPath(name = "auth.db"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "auth-store-open-"));
  directories.push(directory);
  return join(directory, name);
}

describe("SqliteStore.open", () => {
  it("rejects an empty path", async () => {
    await expect(SqliteStore.open("", signal)).rejects.toMatchObject({
      cause: { message: "Empty SQLite database path." },
    });
  });

  it("does not create missing parent directories", async () => {
    const path = join(await temporaryPath(), "missing", "auth.db");
    await expect(SqliteStore.open(path, signal)).rejects.toMatchObject({
      cause: { code: "ENOENT" },
    });
  });

  it("does not create a file for a pre-aborted open", async () => {
    const path = await temporaryPath();
    const reason = new DOMException("startup interrupted", "AbortError");
    const failure: unknown = await SqliteStore.open(
      path,
      AbortSignal.abort(reason),
    ).catch((error: unknown) => error);
    expect(findError(failure, BusyError)).toBeInstanceOf(BusyError);
    expect(findError(failure, DOMException)).toBe(reason);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["auth.db", "file:literal?mode=memory", ":memory:"])(
    "resolves %s as a filesystem path before connecting",
    async (name) => {
      const path = await temporaryPath(name);
      stores.push(
        await SqliteStore.open(relative(process.cwd(), path), signal),
      );
      expect((await readFile(path)).subarray(0, 16).toString("utf8")).toBe(
        "SQLite format 3\0",
      );
    },
  );

  it("preserves a corrupt database instead of replacing it", async () => {
    const path = await temporaryPath();
    await writeFile(path, "invalid database contents", { mode: 0o600 });
    await expect(SqliteStore.open(path, signal)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("invalid database contents");
  });

  it("does not retry a busy schema initialization after WAL is enabled", async () => {
    const path = await temporaryPath();
    await writeFile(path, "", { mode: 0o600 });
    const locker = new Database(path);
    locker.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const failure: unknown = await SqliteStore.open(path, signal).catch(
        (error: unknown) => error,
      );
      expect(findError(failure, BusyError)).toBeInstanceOf(BusyError);
      expect(vi.getTimerCount()).toBe(0);
      locker.exec("ROLLBACK");
      stores.push(await SqliteStore.open(path, signal));
    } finally {
      locker.close();
    }
  }, 15000);
});
