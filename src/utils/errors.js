/**
 * Base error class for application errors
 */
export class AppError extends Error {
  constructor(message, code = 'APP_ERROR', statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Configuration error - thrown when required configuration is missing or invalid
 */
export class ConfigurationError extends AppError {
  constructor(message, code = 'CONFIG_ERROR') {
    super(message, code, 500);
  }
}

/**
 * Validation error - thrown when input validation fails
 */
export class ValidationError extends AppError {
  constructor(message, code = 'VALIDATION_ERROR', statusCode = 400) {
    super(message, code, statusCode);
  }
}

/**
 * Network error - thrown when network operations fail
 */
export class NetworkError extends AppError {
  constructor(message, code = 'NETWORK_ERROR', statusCode = 500) {
    super(message, code, statusCode);
  }
}
