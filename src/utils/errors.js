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
 * File error - thrown when file operations fail
 */
export class FileError extends AppError {
  constructor(message, code = 'FILE_ERROR', statusCode = 500) {
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

/**
 * Rate limit error - thrown when rate limit is exceeded
 */
export class RateLimitError extends AppError {
  constructor(message = 'rate limit exceeded', code = 'RATE_LIMIT_ERROR', statusCode = 429) {
    super(message, code, statusCode);
  }
}

/**
 * Conversion error - thrown when video/image conversion fails
 */
export class ConversionError extends AppError {
  constructor(message, code = 'CONVERSION_ERROR', statusCode = 500) {
    super(message, code, statusCode);
  }
}


