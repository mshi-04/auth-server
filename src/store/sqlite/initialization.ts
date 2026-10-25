import { Database } from "node:sqlite";
import { isBusy, operationError, throwIfAborted } from "./errors.ts";

const retryTimeoutMs = 5000;
const retryIntervalMs = 10;

export async function openDatabase(
  path: string,
  signal: AbortSignal,
): Promise<Database> {
  throwIfAborted(signal);
  const deadline = performance.now() + retryTimeoutMs;
  let lastError: unknown;

  for (;;) {
    if (
      signal.aborted ||
      (lastError !== undefined && performance.now() >= deadline)
    ) {
      throw operationError(lastError, "open SQLite database", signal);
    }

    let db: Database;
    try {
      db = new Database(path, {
        enableForeignKeyConstraints: true,
        timeout: 5000,
      });
    } catch (error) {
      throw operationError(error, "connect to SQLite database", signal);
    }

    try {
      const row = db.prepare("PRAGMA journal_mode = WAL").get();
      if (row?.journal_mode !== "wal") {
        throw new Error("SQLite database must use WAL journal mode");
      }
      throwIfAborted(signal);
      return db;
    } catch (error) {
      db.close();
      if (!isBusy(error)) {
        throw operationError(error, "enable SQLite WAL journal mode", signal);
      }
      lastError = error;
    }

    const waitMs = Math.min(retryIntervalMs, deadline - performance.now());
    if (waitMs <= 0) {
      throw operationError(lastError, "enable SQLite WAL journal mode", signal);
    }
    try {
      await waitForRetry(waitMs, signal);
    } catch {
      throw operationError(
        lastError,
        "wait to retry SQLite WAL journal mode",
        signal,
      );
    }
  }
}

function waitForRetry(waitMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, waitMs);

    function abort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("SQLite retry interrupted", { cause: signal.reason }));
    }

    signal.addEventListener("abort", abort, { once: true });
  });
}
