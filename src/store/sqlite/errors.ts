import { BusyError } from "../../errors/index.ts";

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

export function isBusy(error: unknown): boolean {
  const code = sqliteCode(error);
  return code !== undefined && (code & 0xff) === 5;
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
  if (signal.aborted) {
    return new BusyError(context, {
      cause: new AggregateError([error], "SQLite operation interrupted.", {
        cause: signal.reason,
      }),
    });
  }
  if (isBusy(error)) {
    return new BusyError(context, { cause: error });
  }
  return new Error(context, { cause: error });
}
