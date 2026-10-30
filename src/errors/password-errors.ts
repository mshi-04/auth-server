export class InvalidParamsError extends Error {
  override readonly name = "InvalidParamsError";

  constructor(
    message = "Invalid password parameters.",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class PolicyViolationError extends Error {
  override readonly name = "PolicyViolationError";

  constructor(message = "Password policy violation.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class InvalidHashError extends Error {
  override readonly name = "InvalidHashError";

  constructor(message = "Invalid password hash.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class PasswordBusyError extends Error {
  override readonly name = "PasswordBusyError";

  constructor(message = "Password hasher busy.", options?: ErrorOptions) {
    super(message, options);
  }
}
