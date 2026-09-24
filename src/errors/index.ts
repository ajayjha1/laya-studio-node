/**
 * Typed, actionable errors.
 *
 * Every failure a caller can hit is one of these five. The `message` is written
 * to tell someone what to do next, not merely what broke.
 */

export type LayaErrorCode =
  | 'CONNECTION'
  | 'TIMEOUT'
  | 'VALIDATION'
  | 'INFERENCE'
  | 'MODEL'
  | 'AUTH';

export abstract class LayaError extends Error {
  abstract readonly code: LayaErrorCode;
  /** The endpoint the call was made against, when there was one. */
  readonly endpoint?: string;
  override readonly cause?: unknown;

  constructor(message: string, options: { endpoint?: string; cause?: unknown } = {}) {
    super(message);
    this.name = new.target.name;
    if (options.endpoint !== undefined) this.endpoint = options.endpoint;
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** The server could not be reached at all: refused, DNS failure, socket reset. */
export class LayaConnectionError extends LayaError {
  readonly code = 'CONNECTION' as const;

  static at(endpoint: string, cause: unknown): LayaConnectionError {
    return new LayaConnectionError(
      `Unable to connect to Laya at ${endpoint}.\n\n` +
        `Check that the Laya server is running:\n` +
        `  pip install "laya[serve]" && laya-serve\n\n` +
        `If it runs elsewhere, set LAYA_ENDPOINT or pass { endpoint } to new Laya().`,
      { endpoint, cause },
    );
  }
}

/** The request outlived its deadline. */
export class LayaTimeoutError extends LayaError {
  readonly code = 'TIMEOUT' as const;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, endpoint: string) {
    super(
      `Laya request to ${endpoint} timed out after ${timeoutMs}ms.\n\n` +
        `A cold checkpoint build can take several seconds on first use. Either raise\n` +
        `the timeout (new Laya({ timeout: 30000 })) or start the server with\n` +
        `LAYA_PRELOAD=1 so checkpoints load before the first request.`,
      { endpoint },
    );
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The request was rejected as malformed — by us before sending, or by the
 * server (HTTP 400/413/422). These are caller bugs and are never retried.
 */
export class LayaValidationError extends LayaError {
  readonly code = 'VALIDATION' as const;
  readonly status?: number;

  constructor(message: string, options: { endpoint?: string; status?: number; cause?: unknown } = {}) {
    super(message, options);
    if (options.status !== undefined) this.status = options.status;
  }
}

/** The server accepted the request but inference failed (HTTP 5xx). */
export class LayaInferenceError extends LayaError {
  readonly code = 'INFERENCE' as const;
  readonly status?: number;

  constructor(message: string, options: { endpoint?: string; status?: number; cause?: unknown } = {}) {
    super(message, options);
    if (options.status !== undefined) this.status = options.status;
  }
}

/** A response arrived but did not contain the answer that was asked for. */
export class LayaModelError extends LayaError {
  readonly code = 'MODEL' as const;
}

/** `LAYA_API_KEY` is set on the server and the supplied bearer token did not match. */
export class LayaAuthError extends LayaError {
  readonly code = 'AUTH' as const;

  static at(endpoint: string): LayaAuthError {
    return new LayaAuthError(
      `Laya at ${endpoint} rejected the API key.\n\n` +
        `The server was started with LAYA_API_KEY set, so requests must carry a\n` +
        `matching bearer token. Set LAYA_API_KEY in this process, or pass\n` +
        `new Laya({ apiKey }).`,
      { endpoint },
    );
  }
}

/** Narrowing helper for `catch` blocks. */
export function isLayaError(error: unknown): error is LayaError {
  return error instanceof LayaError;
}

/**
 * Map an HTTP status from `/v1/systemone` onto the right error type.
 * The status codes are exactly those laya/serve.py raises.
 */
export function errorFromStatus(
  status: number,
  detail: string,
  endpoint: string,
): LayaError {
  if (status === 401) return LayaAuthError.at(endpoint);
  if (status === 400 || status === 413 || status === 422) {
    return new LayaValidationError(`Laya rejected the request (HTTP ${status}): ${detail}`, {
      endpoint,
      status,
    });
  }
  if (status === 404) {
    return new LayaConnectionError(
      `Laya at ${endpoint} has no /v1/systemone route (HTTP 404).\n\n` +
        `The endpoint should be the server's base URL, without a path —\n` +
        `for example http://localhost:8000, not http://localhost:8000/v1/systemone.`,
      { endpoint },
    );
  }
  return new LayaInferenceError(`Laya inference failed (HTTP ${status}): ${detail}`, {
    endpoint,
    status,
  });
}
