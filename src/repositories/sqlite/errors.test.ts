import { describe, expect, it } from "vitest";
import { BusyError, findError } from "../../errors/index.ts";
import {
  isBusy,
  operationError,
  sqliteCode,
  throwIfAborted,
  withoutSqliteMessage,
} from "./errors.ts";

describe("SQLite error classification", () => {
  it.each([5, 261, 517, 773])("recognizes busy code %i", (errcode) => {
    expect(isBusy({ code: "ERR_SQLITE_ERROR", errcode })).toBe(true);
  });

  it.each([
    undefined,
    null,
    "SQLITE_BUSY",
    new Error("UNIQUE constraint failed: users.email_normalized"),
    { errcode: 5 },
    { code: "SQLITE_BUSY", errcode: 5 },
    { code: "ERR_SQLITE_ERROR", errcode: "5" },
    { code: "ERR_SQLITE_ERROR", errcode: Number.NaN },
    { code: "ERR_SQLITE_ERROR", errcode: 5.5 },
    { code: "ERR_SQLITE_ERROR", errcode: Infinity },
  ])("does not classify malformed metadata %#", (error) => {
    expect(sqliteCode(error)).toBeUndefined();
    expect(isBusy(error)).toBe(false);
    expect(
      operationError(error, "operation failed", new AbortController().signal),
    ).not.toBeInstanceOf(BusyError);
  });

  it.each([1555, 2067, 19, 6])(
    "keeps non-busy code %i unexpected",
    (errcode) => {
      const original = { code: "ERR_SQLITE_ERROR", errcode };
      const wrapped = operationError(
        original,
        "operation failed",
        new AbortController().signal,
      );
      expect(wrapped).not.toBeInstanceOf(BusyError);
      expect(wrapped.cause).toBeInstanceOf(Error);
      expect(wrapped.cause).toMatchObject({
        name: "SqliteError",
        message: `SQLite error ${errcode.toString()}.`,
        code: "ERR_SQLITE_ERROR",
        errcode,
      });
    },
  );

  it("keeps busy SQLite metadata without its message", () => {
    const original = Object.assign(new Error("database is locked"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
    });
    const wrapped = operationError(
      original,
      "operation failed",
      new AbortController().signal,
    );
    expect(wrapped).toBeInstanceOf(BusyError);
    expect(wrapped.cause).not.toBe(original);
    expect(wrapped.cause).toMatchObject({
      message: "SQLite error 5.",
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
    });
    expect(isBusy(wrapped.cause)).toBe(true);
  });

  it("drops the SQLite message from a cancelled failure", () => {
    const original = Object.assign(
      new Error("UNIQUE constraint failed: users.email_normalized"),
      { code: "ERR_SQLITE_ERROR", errcode: 2067 },
    );
    const wrapped = operationError(
      original,
      "operation failed",
      AbortSignal.abort(new Error("cancelled")),
    );
    expect(wrapped.cause).toBeInstanceOf(AggregateError);
    if (!(wrapped.cause instanceof AggregateError)) {
      throw new Error("Expected original failure to be retained.");
    }
    expect(wrapped.cause.errors).toMatchObject([
      { message: "SQLite error 2067.", errcode: 2067 },
    ]);
  });

  it("passes non-SQLite failures through unchanged", () => {
    const original = new Error("SQLite database must use WAL journal mode");
    expect(withoutSqliteMessage(original)).toBe(original);
  });

  it("prioritizes cancellation for any failure and retains both causes", () => {
    const reason = new DOMException("request cancelled", "AbortError");
    const signal = AbortSignal.abort(reason);
    const original = new Error("database failure");
    const wrapped = operationError(original, "operation failed", signal);
    expect(wrapped).toBeInstanceOf(BusyError);
    expect(findError(wrapped, DOMException)).toBe(reason);
    expect(wrapped.cause).toBeInstanceOf(AggregateError);
    if (!(wrapped.cause instanceof AggregateError)) {
      throw new Error("Expected original failure to be retained.");
    }
    expect(wrapped.cause.errors).toEqual([original]);
  });

  it("rejects an already aborted operation before work starts", () => {
    const reason = { request: "cancelled" };
    expect(() => {
      throwIfAborted(AbortSignal.abort(reason));
    }).toThrow(
      new BusyError("SQLite operation interrupted.", { cause: reason }),
    );
  });

  it("allows work with a live signal", () => {
    expect(() => {
      throwIfAborted(new AbortController().signal);
    }).not.toThrow();
  });
});
