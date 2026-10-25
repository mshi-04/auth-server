export class EmailTakenError extends Error {
  override name = "EmailTakenError";

  constructor(message = "Email already registered.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class UserNotFoundError extends Error {
  override name = "UserNotFoundError";

  constructor(message = "User not found.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class BusyError extends Error {
  override name = "BusyError";

  constructor(message = "Authentication busy.", options?: ErrorOptions) {
    super(message, options);
  }
}
