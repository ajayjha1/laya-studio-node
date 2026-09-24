/**
 * Express integration for laya-studio.
 *
 * ```ts
 * import { layaMiddleware } from 'laya-studio/express';
 * ```
 *
 * Express is typed structurally here rather than imported, so this module adds
 * no dependency — not even `@types/express` — and the core package stays clean.
 */

import type { Laya, DecisionSpec, DecideResults, AnyResult } from '../../src/index.js';
import { isLayaError } from '../../src/index.js';

/** The slice of `express.Request` this middleware touches. */
export interface MinimalRequest {
  body?: unknown;
  query?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

export interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: unknown): unknown;
}

export type NextFunction = (error?: unknown) => void;

export type ExpressMiddleware = (
  req: MinimalRequest,
  res: MinimalResponse,
  next: NextFunction,
) => void | Promise<void>;

export interface LayaMiddlewareOptions<D extends Record<string, DecisionSpec>> {
  laya: Laya;
  /** The decisions to run on each request. */
  decisions: D;
  /**
   * Pull the text to classify out of the request.
   * Defaults to `req.body.input`, then `req.body.message`, then `req.body.text`.
   */
  input?: (req: MinimalRequest) => string | undefined;
  /** Property to attach results to. Default `laya`. */
  property?: string;
  /** Minimum confidence. Defaults to the client's threshold. */
  threshold?: number;
  /**
   * What to do when no decision clears the threshold.
   * `continue` (default) attaches the result anyway and lets the handler decide;
   * `reject` answers 422 without running the handler.
   */
  onLowConfidence?: 'continue' | 'reject';
  /** Fail open (call `next()`) instead of `next(error)` when Laya is unreachable. */
  failOpen?: boolean;
}

/** What the middleware attaches to the request. */
export interface LayaRequestContext<D extends Record<string, DecisionSpec>> {
  results: DecideResults<D>;
  /** True when every decision cleared the threshold. */
  confident: boolean;
  /** Names of the decisions that did not clear it. */
  lowConfidence: string[];
  input: string;
}

function defaultInput(req: MinimalRequest): string | undefined {
  const body = req.body;
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ['input', 'message', 'text', 'query', 'prompt']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return undefined;
}

/**
 * Run Laya decisions before a route handler and attach the result to the request.
 *
 * The middleware never decides whether the request is *allowed* — it attaches a
 * signal. Authorization stays in your handler; see the security notes in the
 * README for why a model's output must not be an authorization boundary.
 */
export function layaMiddleware<const D extends Record<string, DecisionSpec>>(
  options: LayaMiddlewareOptions<D>,
): ExpressMiddleware {
  const {
    laya,
    decisions,
    input: extract = defaultInput,
    property = 'laya',
    onLowConfidence = 'continue',
    failOpen = false,
  } = options;

  return async (req, res, next) => {
    const text = extract(req);
    if (text === undefined || text.trim() === '') {
      res.status(400).json({
        error: 'missing_input',
        message: 'No text to classify. Send { "input": "..." } or supply an `input` extractor.',
      });
      return;
    }

    const threshold = options.threshold ?? laya.threshold;

    try {
      const results = await laya.decide({ input: text, decisions, threshold });

      const lowConfidence = Object.entries(results as Record<string, AnyResult>)
        .filter(([, result]) => !result.isConfident(threshold))
        .map(([name]) => name);

      const context: LayaRequestContext<D> = {
        results,
        confident: lowConfidence.length === 0,
        lowConfidence,
        input: text,
      };
      (req as Record<string, unknown>)[property] = context;

      if (onLowConfidence === 'reject' && lowConfidence.length > 0) {
        res.status(422).json({
          error: 'low_confidence',
          message: `Laya was not confident enough about: ${lowConfidence.join(', ')}.`,
          threshold,
        });
        return;
      }

      next();
    } catch (error) {
      if (failOpen) {
        // The application asked to keep serving when the decision layer is down.
        (req as Record<string, unknown>)[property] = undefined;
        next();
        return;
      }
      next(isLayaError(error) ? error : new Error(String(error)));
    }
  };
}

/**
 * Guardrail middleware: reject a request when any yes/no check fires.
 *
 * This is a filter, not a security boundary. Treat it as one signal among
 * several, never as the only thing between a user and a privileged action.
 */
export function layaScreen(options: {
  laya: Laya;
  checks: Record<string, string>;
  input?: (req: MinimalRequest) => string | undefined;
  flagAt?: number;
  status?: number;
  failOpen?: boolean;
}): ExpressMiddleware {
  const { laya, checks, input: extract = defaultInput, flagAt = 0.5, status = 400, failOpen = false } = options;

  return async (req, res, next) => {
    const text = extract(req);
    if (text === undefined || text.trim() === '') {
      res.status(400).json({ error: 'missing_input', message: 'No text to screen.' });
      return;
    }

    try {
      const result = await laya.screen({ input: text, checks, flagAt });
      (req as Record<string, unknown>).layaScreen = result;

      if (!result.passed) {
        res.status(status).json({
          error: 'screening_failed',
          flagged: result.flagged,
        });
        return;
      }
      next();
    } catch (error) {
      if (failOpen) {
        next();
        return;
      }
      next(isLayaError(error) ? error : new Error(String(error)));
    }
  };
}
