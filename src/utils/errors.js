/**
 * Base error class for application errors
 */
export class AppError extends Error {
  constructor(message, code = 'APP_ERROR', statusCode = 500, options = undefined) {
    super(message, options);
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
  constructor(message, code = 'CONFIG_ERROR', options = undefined) {
    super(message, code, 500, options);
  }
}

/**
 * Validation error - thrown when input validation fails
 */
export class ValidationError extends AppError {
  constructor(message, code = 'VALIDATION_ERROR', statusCode = 400, options = undefined) {
    super(message, code, statusCode, options);
  }
}

/**
 * Network error - thrown when network operations fail
 */
export class NetworkError extends AppError {
  constructor(message, code = 'NETWORK_ERROR', statusCode = 500, options = undefined) {
    super(message, code, statusCode, options);
  }
}

export function rootCause(error) {
  let current = error;
  while (current?.cause) current = current.cause;
  return current;
}

const pathOf = url => {
  try {
    const { host, pathname } = new URL(url);
    return `${host}${pathname}`;
  } catch {
    return url ?? '';
  }
};

// The specific reason an upstream call failed, as one string: endpoint and status for HTTP, method
// and Discord code for Discord, else the message.
export function describeCause(error) {
  if (!error) return null;
  if (typeof error === 'string') return error;
  const { config, response } = error;
  if (config?.url) {
    const endpoint = `${(config.method || 'get').toUpperCase()} ${pathOf(config.baseURL ? config.baseURL + config.url : config.url)}`;
    if (response) return `${endpoint} HTTP ${response.status}`;
    return `${endpoint} ${error.code ?? error.message}`;
  }
  if (error.$metadata?.httpStatusCode) {
    return `r2 ${error.name} HTTP ${error.$metadata.httpStatusCode}: ${error.message}`;
  }
  if (error.method && error.status !== undefined) {
    const body = error.code === undefined ? '(empty body)' : `code ${error.code}`;
    return `discord ${error.method} ${error.status} ${body}${error.message ? `: ${error.message}` : ''}`;
  }
  const code = error.code && !String(error.message).includes(error.code) ? `${error.code}: ` : '';
  return `${code}${error.message ?? String(error)}`;
}

// Records why a curated error was thrown without changing what the user is told.
export function withCause(error, cause) {
  error.cause = typeof cause === 'string' ? new Error(cause) : cause;
  return error;
}

// The one answer for a post that is deleted, private or never existed, from any extractor.
export const contentGone = cause =>
  withCause(
    new NetworkError('this post is unavailable, it may be deleted or private', 'CONTENT_GONE'),
    cause
  );
