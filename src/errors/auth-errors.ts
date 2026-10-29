export class InvalidEmailError extends Error {
  override name = "InvalidEmailError";

  constructor(message = "Invalid email address.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class WeakPasswordError extends Error {
  override name = "WeakPasswordError";

  constructor(message = "Weak password.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class EmailTakenError extends Error {
  override name = "EmailTakenError";

  constructor(message = "Email already registered.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class InvalidCredentialsError extends Error {
  override name = "InvalidCredentialsError";

  constructor(message = "Invalid credentials.", options?: ErrorOptions) {
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
