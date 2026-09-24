/**
 * Fastify integration for laya-studio.
 *
 * ```ts
 * import { layaPreHandler } from 'laya-studio/fastify';
 * ```
 *
 * As with the Express integration, Fastify is typed structurally rather than
 * imported, so this adds no dependency.
 */

import type { Laya, DecisionSpec, DecideResults, AnyResult } from '../../src/index.js';

export interface MinimalFastifyRequest {
  body?: unknown;
  query?: unknown;
  params?: unknown;
  [key: string]: unknown;
}

export interface MinimalFastifyReply {
  code(statusCode: number): MinimalFastifyReply;
  send(payload: unknown): unknown;
}

export type FastifyPreHandler = (
  request: MinimalFastifyRequest,
  reply: MinimalFastifyReply,
) => Promise<void>;

export interface LayaPreHandlerOptions<D extends Record<string, DecisionSpec>> {
  laya: Laya;
  decisions: D;
  input?: (request: MinimalFastifyRequest) => string | undefined;
  property?: string;
  threshold?: number;
  onLowConfidence?: 'continue' | 'reject';
  failOpen?: boolean;
}

export interface LayaRequestContext<D extends Record<string, DecisionSpec>> {
  results: DecideResults<D>;
  confident: boolean;
  lowConfidence: string[];
  input: string;
}

function defaultInput(request: MinimalFastifyRequest): string | undefined {
  const body = request.body;
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
 * A `preHandler` hook that runs Laya decisions and decorates the request.
 *
 * Returning without calling `reply.send` lets Fastify continue to the route.
 */
export function layaPreHandler<const D extends Record<string, DecisionSpec>>(
  options: LayaPreHandlerOptions<D>,
): FastifyPreHandler {
  const {
    laya,
    decisions,
    input: extract = defaultInput,
    property = 'laya',
    onLowConfidence = 'continue',
    failOpen = false,
  } = options;

  return async (request, reply) => {
    const text = extract(request);
    if (text === undefined || text.trim() === '') {
      await reply.code(400).send({
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
      (request as Record<string, unknown>)[property] = context;

      if (onLowConfidence === 'reject' && lowConfidence.length > 0) {
        await reply.code(422).send({
          error: 'low_confidence',
          message: `Laya was not confident enough about: ${lowConfidence.join(', ')}.`,
          threshold,
        });
      }
    } catch (error) {
      if (failOpen) return;
      throw error;
    }
  };
}

/**
 * Fastify plugin that decorates the instance with a shared client.
 *
 * ```ts
 * await fastify.register(layaPlugin, { laya: new Laya() });
 * fastify.laya.classify(...)
 * ```
 */
export function layaPlugin(
  fastify: { decorate(name: string, value: unknown): unknown },
  options: { laya: Laya; property?: string },
  done?: () => void,
): void {
  fastify.decorate(options.property ?? 'laya', options.laya);
  done?.();
}
