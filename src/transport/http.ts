import {
  LayaConnectionError,
  LayaTimeoutError,
  LayaValidationError,
  errorFromStatus,
} from '../errors/index.js';
import { normalizeEndpoint } from '../config.js';
import type { LayaTransport, TransportRequest } from './index.js';

export interface HttpTransportOptions {
  endpoint: string;
  apiKey?: string;
  timeout: number;
  retries: number;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

/** Retry only what a retry can fix: no connection, or the server faulting. */
function isRetryable(error: unknown): boolean {
  if (error instanceof LayaConnectionError) return true;
  // 5xx arrives as LayaInferenceError with a status; 4xx never does.
  const status = (error as { status?: number } | null)?.status;
  return typeof status === 'number' && status >= 500;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * HTTP transport for `laya-serve`.
 *
 * Uses the global `fetch` (Node 18+), so the package ships with no runtime
 * dependencies at all.
 */
export class HttpTransport implements LayaTransport {
  readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: HttpTransportOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.apiKey = options.apiKey;
    this.timeout = options.timeout;
    this.retries = Math.max(0, options.retries);
    this.headers = options.headers ?? {};

    const impl = options.fetch ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new LayaValidationError(
        'No global fetch available. Use Node 18.17+, or pass { fetch } to new Laya().',
      );
    }
    this.fetchImpl = impl;
  }

  async request<T>(request: TransportRequest): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.attempt<T>(request);
      } catch (error) {
        lastError = error;
        if (attempt === this.retries || !isRetryable(error)) throw error;
        // Exponential backoff, capped: 100ms, 200ms, 400ms…
        await sleep(Math.min(100 * 2 ** attempt, 2000));
      }
    }
    throw lastError;
  }

  private async attempt<T>(request: TransportRequest): Promise<T> {
    const url = `${this.endpoint}${request.path}`;
    const timeoutMs = request.timeoutMs ?? this.timeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // An external signal must also abort us, without leaking a listener. A signal
    // that is *already* aborted will never fire its event again, so adding a
    // listener would silently let the request run to completion; check first.
    const onExternalAbort = (): void => controller.abort();
    if (request.signal?.aborted) controller.abort();
    else request.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      // An abort is ours (timeout) or the caller's; only ours becomes a timeout error.
      if (controller.signal.aborted && !request.signal?.aborted) {
        throw new LayaTimeoutError(timeoutMs, this.endpoint);
      }
      if (request.signal?.aborted) throw error;
      throw LayaConnectionError.at(this.endpoint, error);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }

    const text = await response.text();
    if (!response.ok) {
      throw errorFromStatus(response.status, extractDetail(text), this.endpoint);
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new LayaConnectionError(
        `Laya at ${this.endpoint} returned a non-JSON response to ${request.path}.\n\n` +
          `Is the endpoint pointing at the Laya server, and not at a proxy or web page?`,
        { endpoint: this.endpoint, cause: error },
      );
    }
  }
}

/** FastAPI puts the useful message in `detail`; fall back to the raw body. */
function extractDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
      const detail = (parsed as { detail: unknown }).detail;
      return typeof detail === 'string' ? detail : JSON.stringify(detail);
    }
  } catch {
    // Not JSON — the raw text is the best detail we have.
  }
  return body.slice(0, 500) || '(empty response body)';
}
