import { describe, expect, it } from "vitest";
import {
  BusyError,
  EmailTakenError,
  InvalidCredentialsError,
  InvalidEmailError,
  PasswordBusyError,
  UserNotFoundError,
  WeakPasswordError,
  findError,
} from "./index.ts";

interface AuthErrorCase {
  name: string;
  defaultMessage: string;
  ErrorClass: new (message?: string, options?: ErrorOptions) => Error;
}

const authErrorCases: AuthErrorCase[] = [
  {
    name: "InvalidEmailError",
    defaultMessage: "Invalid email address.",
    ErrorClass: InvalidEmailError,
  },
  {
    name: "WeakPasswordError",
    defaultMessage: "Weak password.",
    ErrorClass: WeakPasswordError,
  },
  {
    name: "EmailTakenError",
    defaultMessage: "Email already registered.",
    ErrorClass: EmailTakenError,
  },
  {
    name: "InvalidCredentialsError",
    defaultMessage: "Invalid credentials.",
    ErrorClass: InvalidCredentialsError,
  },
  {
    name: "UserNotFoundError",
    defaultMessage: "User not found.",
    ErrorClass: UserNotFoundError,
  },
  {
    name: "BusyError",
    defaultMessage: "Authentication busy.",
    ErrorClass: BusyError,
  },
];

describe("authentication errors", () => {
  it.each(authErrorCases)(
    "$name sets name, default message, custom message, and cause",
    ({ name, defaultMessage, ErrorClass }) => {
      const defaultError = new ErrorClass();
      expect(defaultError).toBeInstanceOf(Error);
      expect(defaultError).toBeInstanceOf(ErrorClass);
      expect(defaultError.name).toBe(name);
      expect(defaultError.message).toBe(defaultMessage);
      expect(defaultError.cause).toBeUndefined();

      const cause = new Error("underlying failure");
      const customError = new ErrorClass("custom failure", { cause });
      expect(customError.name).toBe(name);
      expect(customError.message).toBe("custom failure");
      expect(customError.cause).toBe(cause);

      const wrapped = new Error("outer wrapper", { cause: customError });
      expect(findError(wrapped, ErrorClass)).toBe(customError);
    },
  );
});

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
