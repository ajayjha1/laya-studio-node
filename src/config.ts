import type { LayaCache } from './cache/index.js';
import type { LayaHooks } from './hooks/index.js';
import type { LayaTransport } from './transport/index.js';

export interface CacheOptions {
  enabled?: boolean;
  /** Time-to-live in **seconds**, matching the documented `ttl: 300` form. */
  ttl?: number;
  /** Maximum entries held by the built-in in-memory cache. */
  maxEntries?: number;
  /** Bring your own store (Redis, etc). When set, `ttl`/`maxEntries` are yours to honour. */
  store?: LayaCache;
}

export interface LayaConfig {
  /** Base URL of the Laya server, without a path. Default `http://localhost:8000`. */
  endpoint?: string;
  /** Bearer token, required only when the server runs with `LAYA_API_KEY` set. */
  apiKey?: string;
  /**
   * Checkpoint to pin: `english` | `multilingual` | `typed-decisions`, or a
   * published Hugging Face id. Omit to let the server's Router auto-select.
   */
  model?: string;
  /** Per-request deadline in milliseconds. Default 10000. */
  timeout?: number;
  /** Default confidence threshold for `isConfident()`, routing and fallback. Default 0.8. */
  threshold?: number;
  /** Retry count for transient failures (connection/5xx). Default 2. Validation is never retried. */
  retries?: number;
  /** Maximum in-flight HTTP requests when batching. Default 8. */
  concurrency?: number;
  cache?: CacheOptions;
  hooks?: LayaHooks;
  /** Swap the HTTP transport, e.g. for tests or a custom network stack. */
  transport?: LayaTransport;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** `fetch` implementation. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
}

export const DEFAULTS = {
  endpoint: 'http://localhost:8000',
  timeout: 10_000,
  threshold: 0.8,
  retries: 2,
  concurrency: 8,
} as const;

/**
 * Identity helper giving `laya.config.ts` full type-checking and completion.
 *
 * ```ts
 * import { defineConfig } from 'laya-studio';
 * export default defineConfig({ endpoint: 'http://localhost:8000', threshold: 0.8 });
 * ```
 */
export function defineConfig(config: LayaConfig): LayaConfig {
  return config;
}

function readNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} is not a number.`);
  }
  return value;
}

/**
 * Read configuration from the environment.
 *
 * Precedence is explicit options > environment > defaults, so a value passed to
 * `new Laya()` always wins. Secrets are only ever read from the environment;
 * none are baked into the package.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LayaConfig {
  const config: LayaConfig = {};
  if (env.LAYA_ENDPOINT) config.endpoint = env.LAYA_ENDPOINT;
  if (env.LAYA_API_KEY) config.apiKey = env.LAYA_API_KEY;
  if (env.LAYA_MODEL) config.model = env.LAYA_MODEL;

  const timeout = readNumber(env.LAYA_TIMEOUT, 'LAYA_TIMEOUT');
  if (timeout !== undefined) config.timeout = timeout;

  const threshold = readNumber(env.LAYA_THRESHOLD, 'LAYA_THRESHOLD');
  if (threshold !== undefined) config.threshold = threshold;

  return config;
}

/** Merge explicit options over the environment over the defaults. */
export function resolveConfig(
  options: LayaConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): LayaConfig {
  return { ...configFromEnv(env), ...options };
}

/** Strip a trailing slash so `${endpoint}/v1/systemone` never doubles up. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}
