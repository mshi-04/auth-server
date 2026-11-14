export class BadRequestError extends Error {
  override readonly name = "BadRequestError";
  readonly kind: "invalid-input" | "read-failed" | "invalid-host";

  constructor(
    kind: "invalid-input" | "read-failed" | "invalid-host" = "invalid-input",
    options?: ErrorOptions,
  ) {
    super("Invalid request.", options);
    this.kind = kind;
  }
}

export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";

  constructor(message = "Forbidden request.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class PayloadTooLargeError extends Error {
  override readonly name = "PayloadTooLargeError";

  constructor(message = "Request body too large.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class UnsupportedMediaTypeError extends Error {
  override readonly name = "UnsupportedMediaTypeError";

  constructor(message = "Unsupported media type.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class NotFoundError extends Error {
  override readonly name = "NotFoundError";

  constructor(message = "Resource not found.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class MethodNotAllowedError extends Error {
  override readonly name = "MethodNotAllowedError";
  readonly allowedMethods: readonly string[];

  constructor(allowedMethods: readonly string[], options?: ErrorOptions) {
    super("Method not allowed.", options);
    this.allowedMethods = [...allowedMethods];
  }
}
