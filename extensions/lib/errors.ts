export class ActsisLiteLLMError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = this.constructor.name;
  }
}

export class ConfigError extends ActsisLiteLLMError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFIG_ERROR", message, options);
  }
}

export class DiscoveryError extends ActsisLiteLLMError {
  constructor(message: string, options?: ErrorOptions) {
    super("DISCOVERY_ERROR", message, options);
  }
}

export class AuthError extends ActsisLiteLLMError {
  constructor(message: string, options?: ErrorOptions) {
    super("AUTH_ERROR", message, options);
  }
}

export class CatalogError extends ActsisLiteLLMError {
  constructor(message: string, options?: ErrorOptions) {
    super("CATALOG_ERROR", message, options);
  }
}

export class CommandError extends ActsisLiteLLMError {
  constructor(message: string, options?: ErrorOptions) {
    super("COMMAND_ERROR", message, options);
  }
}
