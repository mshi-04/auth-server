import { BusyError } from "../../errors/index.ts";

const sqlitePrimaryCodeMask = 0xff;
const sqliteBusyCode = 5;

export function sqliteCode(error: unknown): number | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    error.code !== "ERR_SQLITE_ERROR" ||
    !("errcode" in error) ||
    typeof error.errcode !== "number" ||
    !Number.isSafeInteger(error.errcode)
  ) {
    return undefined;
  }
  return error.errcode;
}

class SqliteFailure extends Error {
  override readonly name = "SqliteError";
  readonly code = "ERR_SQLITE_ERROR";
  readonly errcode: number;

  constructor(errcode: number) {
    super(`SQLite error ${errcode.toString()}.`);
    this.errcode = errcode;
  }
}

export function withoutSqliteMessage(error: unknown): unknown {
  const code = sqliteCode(error);
  return code === undefined ? error : new SqliteFailure(code);
}

export function isBusy(error: unknown): boolean {
  const code = sqliteCode(error);
  return (
    code !== undefined && (code & sqlitePrimaryCodeMask) === sqliteBusyCode
  );
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BusyError("SQLite operation interrupted.", {
      cause: signal.reason,
    });
  }
}

export function operationError(
  error: unknown,
  context: string,
  signal: AbortSignal,
): Error {
  const cause = withoutSqliteMessage(error);
  if (signal.aborted) {
    return new BusyError(context, {
      cause: new AggregateError([cause], "SQLite operation interrupted.", {
        cause: signal.reason,
      }),
    });
  }
  if (isBusy(cause)) {
    return new BusyError(context, { cause });
  }
  return new Error(context, { cause });
}
