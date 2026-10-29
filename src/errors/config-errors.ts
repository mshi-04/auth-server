export class ConfigError extends Error {
  override name = "ConfigError";

  constructor(message = "Invalid configuration.", options?: ErrorOptions) {
    super(message, options);
  }
}
