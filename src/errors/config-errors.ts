export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(message = "Invalid configuration.", options?: ErrorOptions) {
    super(message, options);
  }
}
