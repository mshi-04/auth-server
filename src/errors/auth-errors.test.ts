import { describe, expect, it } from "vitest";
import { BusyError, PasswordBusyError, findError } from "./index.ts";

describe("busy error boundaries", () => {
  it("keeps password contention distinct from authentication contention", () => {
    const reason = new Error("request cancelled");
    const passwordError = new PasswordBusyError(undefined, { cause: reason });
    const authenticationError = new BusyError(undefined, {
      cause: passwordError,
    });

    expect(passwordError.name).toBe("PasswordBusyError");
    expect(passwordError).not.toBeInstanceOf(BusyError);
    expect(authenticationError).not.toBeInstanceOf(PasswordBusyError);
    expect(findError(authenticationError, BusyError)).toBe(authenticationError);
    expect(findError(authenticationError, PasswordBusyError)).toBe(
      passwordError,
    );
    expect(passwordError.cause).toBe(reason);
  });
});
