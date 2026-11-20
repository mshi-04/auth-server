import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rejected } from "../../../tests/support/errors.ts";
import { BusyError } from "../../errors/index.ts";
import { openDatabase } from "./initialization.ts";

const signal = new AbortController().signal;
const directories: string[] = [];
const databases: Database[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of databases.splice(0)) {
    if (db.isOpen) {
      db.close();
    }
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "auth-sqlite-initialization-"),
  );
  directories.push(directory);
  const path = join(directory, "database.sqlite");
  await writeFile(path, "", { mode: 0o600 });
  return path;
}

function lockRollbackDatabase(path: string): Database {
  const db = new Database(path);
  databases.push(db);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE retry_lock (value INTEGER NOT NULL);
    BEGIN IMMEDIATE;
    INSERT INTO retry_lock VALUES (1);
  `);
  return db;
}

function fakeTime(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
}

describe("SQLite connection initialization", () => {
  it("enables WAL, foreign keys and a five-second busy timeout", async () => {
    const db = await openDatabase(await databasePath(), signal);
    databases.push(db);
    expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "wal",
    });
    expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({
      foreign_keys: 1,
    });
    expect(db.prepare("PRAGMA busy_timeout").get()).toMatchObject({
      timeout: 5000,
    });
    expect(db.prepare("SELECT 1 AS connected").get()).toMatchObject({
      connected: 1,
    });
  });

  it("opens an existing WAL database again", async () => {
    const path = await databasePath();
    const first = await openDatabase(path, signal);
    first.exec("CREATE TABLE persisted (value INTEGER)");
    first.close();
    const second = await openDatabase(path, signal);
    databases.push(second);
    expect(
      second.prepare("SELECT count(*) AS count FROM persisted").get(),
    ).toMatchObject({ count: 0 });
  });

  it("retries a locked WAL transition after ten milliseconds", async () => {
    const path = await databasePath();
    const locker = lockRollbackDatabase(path);
    fakeTime();
    let opened = false;
    const pending = openDatabase(path, signal).then((db) => {
      databases.push(db);
      opened = true;
      return db;
    });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(opened).toBe(false);
    locker.exec("ROLLBACK");
    await vi.advanceTimersByTimeAsync(1);
    const db = await pending;
    expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "wal",
    });
    expect(performance.now()).toBe(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops starting retries at the five-second deadline and keeps the SQLite cause", async () => {
    const path = await databasePath();
    lockRollbackDatabase(path);
    fakeTime();
    let failure: unknown;
    const pending = (async () => {
      failure = await rejected(openDatabase(path, signal));
    })();
    await vi.advanceTimersByTimeAsync(4999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(failure).toBeInstanceOf(BusyError);
    expect(failure).toMatchObject({
      cause: { code: "ERR_SQLITE_ERROR", errcode: 5 },
    });
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses monotonic time even if the wall clock jumps", async () => {
    const path = await databasePath();
    const locker = lockRollbackDatabase(path);
    fakeTime();
    vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    const pending = openDatabase(path, signal);
    await vi.advanceTimersByTimeAsync(20);
    locker.exec("ROLLBACK");
    await vi.advanceTimersByTimeAsync(10);
    const db = await pending;
    databases.push(db);
    expect(performance.now()).toBe(30);
  });

  it("cancels waiting immediately and removes the retry timer", async () => {
    const path = await databasePath();
    lockRollbackDatabase(path);
    fakeTime();
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const pending = rejected(openDatabase(path, controller.signal));
    await vi.advanceTimersByTimeAsync(35);
    controller.abort(reason);
    expect(await pending).toMatchObject({
      name: "BusyError",
      cause: {
        cause: reason,
        errors: [{ code: "ERR_SQLITE_ERROR", errcode: 5 }],
      },
    });
    expect(performance.now()).toBe(35);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not connect when the signal is already aborted", async () => {
    const path = await databasePath();
    const controller = new AbortController();
    const reason = new Error("startup cancelled");
    controller.abort(reason);
    fakeTime();
    await expect(openDatabase(path, controller.signal)).rejects.toMatchObject({
      name: "BusyError",
      cause: reason,
    });
    expect(vi.getTimerCount()).toBe(0);
    const db = new Database(path);
    databases.push(db);
    expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "delete",
    });
  });

  it("does not retry a non-SQLite constructor error", async () => {
    const path = join(await databasePath(), "missing.sqlite");
    fakeTime();
    await expect(openDatabase(path, signal)).rejects.toThrow(
      "connect to SQLite database",
    );
    expect(performance.now()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a corrupt database", async () => {
    const path = await databasePath();
    await writeFile(path, "not a SQLite database");
    fakeTime();
    await expect(openDatabase(path, signal)).rejects.toMatchObject({
      cause: { code: "ERR_SQLITE_ERROR", errcode: 26 },
    });
    expect(performance.now()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a database that cannot use WAL without retrying", async () => {
    fakeTime();
    await expect(openDatabase(":memory:", signal)).rejects.toMatchObject({
      cause: { message: "SQLite database must use WAL journal mode" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
