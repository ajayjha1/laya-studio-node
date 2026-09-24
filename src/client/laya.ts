import { randomUUID } from 'node:crypto';

import { DEFAULTS, normalizeEndpoint, resolveConfig, type LayaConfig } from '../config.js';
import { MemoryCache, cacheKey, type LayaCache } from '../cache/index.js';
import { LayaModelError, LayaValidationError } from '../errors/index.js';
import { emit, type LayaHooks } from '../hooks/index.js';
import { HttpTransport, type LayaTransport } from '../transport/index.js';
import { mapWithConcurrency, settleWithConcurrency } from '../util/concurrency.js';
import {
  SERVER_LIMITS,
  type HealthResponse,
  type LayaAnswer,
  type LayaQuestion,
  type LayaState,
  type SystemOneRequest,
  type SystemOneResponse,
} from '../wire.js';
import { specKind, toQuestion, type DecisionSpec } from '../decisions/spec.js';
import { validateQuestions } from '../decisions/validate.js';
import {
  decodeSchemaAnswer,
  planFromJsonSchema,
  type JsonSchemaObject,
} from '../decisions/schema.js';
import {
  toChoiceResult,
  toNoulResult,
  toResult,
  toScoreResult,
  type AnyResult,
  type ChoiceResult,
  type DecideResults,
  type NoulResult,
  type ResultMeta,
  type ScoreResult,
} from '../decisions/results.js';
import { LayaRouter, type RouterOptions, type RouteHandlers } from '../router/router.js';

/** Options every operation accepts. */
export interface CallOptions {
  /** Pin a checkpoint for this call, overriding the client default. */
  model?: string;
  /** Override the client's confidence threshold for this result's `isConfident()`. */
  threshold?: number;
  timeout?: number;
  signal?: AbortSignal;
}

export interface FallbackContext<L extends string> {
  input: LayaState;
  labels: readonly L[];
  /** The low-confidence Laya result that triggered the fallback. */
  result: ChoiceResult<L>;
  confidence: number;
  threshold: number;
}

/**
 * Provider-agnostic escape hatch, called only when Laya is not confident.
 *
 * It returns the label to use, so the result keeps its shape and stays typed.
 * Nothing about it knows or cares which model you call inside.
 *
 * The return type is `Promise<L>` rather than `L | Promise<L>` on purpose: a
 * union return stops TypeScript from contextually typing the returned literal,
 * which would widen `return 'billing'` to `string` and force callers to write
 * `as const`. A fallback exists to call something slower, so it is async
 * anyway; wrap a synchronous one in `async`.
 */
export type ClassifyFallback<L extends string> = (
  context: FallbackContext<L>,
) => Promise<L>;

export interface ClassifyOptions<L extends string> extends CallOptions {
  input: LayaState;
  /**
   * Labels as a list, or as label -> description.
   *
   * `L` is inferred directly from this value rather than through a conditional
   * type, which is what lets TypeScript contextually type `fallback`'s return
   * as the label union instead of widening it to `string`.
   */
  labels: readonly L[] | Readonly<Record<L, string>>;
  /** Override the generated question text. */
  instructions?: string;
  fallback?: ClassifyFallback<L>;
}

export interface DecideOptions<D extends Record<string, DecisionSpec>> extends CallOptions {
  input: LayaState;
  decisions: D;
}

export interface ScoreOptions extends CallOptions {
  input: LayaState;
  levels: readonly string[];
  instructions?: string;
}

export interface ScreenOptions<C extends Record<string, string>> extends CallOptions {
  input: LayaState;
  /** Check name -> the yes/no question that flags it. */
  checks: C;
  /** A check fires when P(yes) is at least this. Default 0.5. */
  flagAt?: number;
}

export interface ScreenResult<C extends Record<string, string>> {
  /** True when no check fired. */
  passed: boolean;
  /** Names of the checks that fired. */
  flagged: Array<keyof C & string>;
  checks: { [K in keyof C]: NoulResult };
  meta: ResultMeta;
}

export interface MatchOptions extends CallOptions {
  a: LayaState;
  b: LayaState;
  instructions?: string;
  /** Override the three verdict labels. */
  labels?: readonly [string, string, string];
}

export type MatchVerdict = 'same' | 'different' | 'unclear';

export interface BatchItem<D extends Record<string, DecisionSpec> = Record<string, DecisionSpec>> {
  input: LayaState;
  decisions: D;
  model?: string;
}

export type BatchOutcome<D extends Record<string, DecisionSpec>> =
  | { ok: true; index: number; results: DecideResults<D> }
  | { ok: false; index: number; error: unknown };

export interface BatchOptions extends CallOptions {
  /** Max requests in flight. Defaults to the client's `concurrency` (8). */
  concurrency?: number;
  /** Reject on the first failure instead of returning per-item outcomes. */
  throwOnError?: boolean;
}

export interface SchemaDecisionOptions extends CallOptions {
  input: LayaState;
  /** A flat JSON Schema object. Each property becomes one Laya question. */
  schema: JsonSchemaObject;
}

/** One decoded field from {@link Laya.decideFromSchema}. */
export interface SchemaFieldResult {
  /** The answer, converted back to the schema's own type. */
  value: string | number | boolean | null;
  confidence: number;
  /** Which question type the property compiled to. */
  kind: 'choice' | 'score' | 'noul';
  raw: LayaAnswer;
  isConfident(threshold?: number): boolean;
}

export interface SchemaDecisionResult {
  /** Property name -> decoded value, matching the schema's shape. */
  values: Record<string, string | number | boolean | null>;
  /** Per-property detail: confidence, question kind, and the raw answer. */
  fields: Record<string, SchemaFieldResult>;
  /** Properties whose answer did not clear the threshold. */
  lowConfidence: string[];
  meta: ResultMeta;
}

interface SystemOneResult {
  answers: Record<string, LayaAnswer>;
  meta: ResultMeta;
  /** The server's response object, untouched. */
  response: SystemOneResponse;
}

export interface PredictOptions extends CallOptions {
  /** Text, or any JSON-serializable record the model should read. */
  state: LayaState;
  /** Raw Laya questions, exactly as `POST /v1/systemone` accepts them. */
  questions: Record<string, LayaQuestion>;
}

/**
 * The server's response, unchanged, plus local timing under `meta`.
 *
 * This extends {@link SystemOneResponse} rather than restating its fields, so a
 * field the server adds in a later version reaches callers instead of being
 * dropped by this SDK. Nothing here is renamed or reinterpreted.
 */
export interface PredictResult extends SystemOneResponse {
  /** Measured by laya-studio, not sent by the server. */
  meta: ResultMeta;
}

/**
 * The Laya client.
 *
 * ```ts
 * const laya = new Laya({ endpoint: 'http://localhost:8000' });
 * const result = await laya.classify({ input: 'My payment failed', labels: ['billing', 'technical'] });
 * ```
 */
export class Laya {
  readonly endpoint: string;
  readonly threshold: number;

  private readonly transport: LayaTransport;
  private readonly hooks: LayaHooks;
  private readonly defaultModel: string | undefined;
  private readonly defaultTimeout: number;
  private readonly concurrency: number;
  private readonly cache: LayaCache | undefined;
  private readonly cacheTtl: number;

  constructor(options: LayaConfig = {}) {
    const config = resolveConfig(options);

    this.endpoint = normalizeEndpoint(config.endpoint ?? DEFAULTS.endpoint);
    this.threshold = config.threshold ?? DEFAULTS.threshold;
    this.defaultModel = config.model;
    this.defaultTimeout = config.timeout ?? DEFAULTS.timeout;
    this.concurrency = config.concurrency ?? DEFAULTS.concurrency;
    this.hooks = config.hooks ?? {};

    if (this.threshold < 0 || this.threshold > 1) {
      throw new LayaValidationError(
        `threshold must be between 0 and 1, got ${this.threshold}. It is compared against a probability.`,
      );
    }

    this.transport =
      config.transport ??
      new HttpTransport({
        endpoint: this.endpoint,
        timeout: this.defaultTimeout,
        retries: config.retries ?? DEFAULTS.retries,
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
        ...(config.headers !== undefined ? { headers: config.headers } : {}),
        ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
      });

    const cacheOptions = config.cache;
    if (cacheOptions?.enabled) {
      this.cache = cacheOptions.store ?? new MemoryCache(cacheOptions.maxEntries ?? 1000);
      this.cacheTtl = cacheOptions.ttl ?? 300;
    } else {
      this.cache = undefined;
      this.cacheTtl = 0;
    }
  }

  // ---------------------------------------------------------------- core call

  /**
   * One `POST /v1/systemone`. Every operation — `predict` included — funnels
   * through here, so caching, hooks, retries and limit checks are defined
   * exactly once and cannot drift between methods.
   *
   * All questions in a single call are answered in one forward pass, which is
   * what makes `decide()` and `screen()` genuinely cheaper than N calls.
   */
  private async systemOne(
    state: LayaState,
    questions: Record<string, LayaQuestion>,
    operation: string,
    options: CallOptions = {},
  ): Promise<SystemOneResult> {
    const names = Object.keys(questions);
    if (names.length === 0) {
      throw new LayaValidationError(`${operation}: at least one question is required.`);
    }
    if (names.length > SERVER_LIMITS.maxQuestions) {
      throw new LayaValidationError(
        `${operation}: ${names.length} questions exceeds the server limit of ` +
          `${SERVER_LIMITS.maxQuestions}. Split them across calls.`,
      );
    }

    const stateLength = typeof state === 'string' ? state.length : JSON.stringify(state ?? '').length;
    if (stateLength > SERVER_LIMITS.maxStateChars) {
      throw new LayaValidationError(
        `${operation}: input is ${stateLength} characters, over the server limit of ` +
          `${SERVER_LIMITS.maxStateChars}. Truncate or summarise it first.`,
      );
    }

    const model = options.model ?? this.defaultModel;
    const body: SystemOneRequest = {
      state,
      questions,
      ...(model !== undefined ? { model } : {}),
    };

    const requestId = randomUUID();
    const requestMeta = {
      requestId,
      operation,
      questionCount: names.length,
      endpoint: this.endpoint,
      ...(model !== undefined ? { model } : {}),
    };

    const key = this.cache ? cacheKey({ endpoint: this.endpoint, body }) : undefined;
    if (key !== undefined && this.cache) {
      const hit = (await this.cache.get(key)) as SystemOneResponse | undefined;
      if (hit) {
        const meta: ResultMeta = {
          requestId,
          latencyMs: 0,
          model: hit.model,
          cached: true,
          ...(hit.routing !== undefined ? { routing: hit.routing } : {}),
          ...(hit.routing?.model !== undefined ? { checkpoint: hit.routing.model } : {}),
          ...(hit.usage !== undefined ? { usage: hit.usage } : {}),
        };
        await emit(this.hooks.onResponse, {
          ...requestMeta,
          latencyMs: 0,
          cached: true,
          reportedModel: hit.model,
          ...(hit.routing?.model !== undefined ? { checkpoint: hit.routing.model } : {}),
          ...(hit.usage !== undefined ? { usage: hit.usage } : {}),
        });
        return { answers: hit.answers, meta, response: hit };
      }
    }

    await emit(this.hooks.onRequest, requestMeta);
    const startedAt = performance.now();

    try {
      const response = await this.transport.request<SystemOneResponse>({
        path: '/v1/systemone',
        method: 'POST',
        body,
        ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });

      const latencyMs = performance.now() - startedAt;

      if (!response || typeof response !== 'object' || typeof response.answers !== 'object') {
        throw new LayaValidationError(
          `Laya returned a response without an "answers" object. ` +
            `Is ${this.endpoint} a Laya server (POST /v1/systemone)?`,
          { endpoint: this.endpoint },
        );
      }

      if (key !== undefined && this.cache) {
        await this.cache.set(key, response, this.cacheTtl);
      }

      await emit(this.hooks.onResponse, {
        ...requestMeta,
        latencyMs,
        cached: false,
        reportedModel: response.model,
        ...(response.routing?.model !== undefined ? { checkpoint: response.routing.model } : {}),
        ...(response.usage !== undefined ? { usage: response.usage } : {}),
      });

      return {
        response,
        answers: response.answers,
        meta: {
          requestId,
          latencyMs,
          model: response.model,
          cached: false,
          ...(response.routing !== undefined ? { routing: response.routing } : {}),
          ...(response.routing?.model !== undefined ? { checkpoint: response.routing.model } : {}),
          ...(response.usage !== undefined ? { usage: response.usage } : {}),
        },
      };
    } catch (error) {
      await emit(this.hooks.onError, {
        ...requestMeta,
        latencyMs: performance.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  // ------------------------------------------------------------------- public

  /**
   * The canonical operation: send Laya any set of questions and get its answers
   * back unchanged.
   *
   * Every other method on this class is a convenience layer over `predict` —
   * `classify` is one `choice` question, `screen` is N `noul` questions, and so
   * on. They exist because they carry types and ergonomics that raw questions
   * cannot. When you need a question shape they do not cover, drop to this one;
   * you lose the typed result and keep everything else (caching, hooks, retries,
   * typed errors, limit checks).
   *
   * ```ts
   * const { answers } = await laya.predict({
   *   state: 'We were billed twice for March.',
   *   questions: {
   *     department: {
   *       type: 'choice',
   *       instructions: 'Which department should handle this?',
   *       criteria: { billing: 'invoices, refunds', technical: 'bugs' },
   *     },
   *     churn: { type: 'noul', instructions: 'Do they threaten to cancel?' },
   *   },
   * });
   *
   * answers.department.choice; // "billing"
   * answers.churn.noul;        // 0.892
   * ```
   */
  async predict(options: PredictOptions): Promise<PredictResult> {
    const { state, questions, ...call } = options;
    validateQuestions(questions);

    const { response, meta } = await this.systemOne(state, questions, 'predict', call);
    // Spread the server's payload first so every field it sent survives, known
    // to this SDK or not. `meta` is the single addition, and it is ours.
    return { ...response, meta };
  }

  /**
   * Assign exactly one label. The returned `label` is typed as the union of the
   * labels you passed.
   */
  async classify<const L extends string>(
    options: ClassifyOptions<L>,
  ): Promise<ChoiceResult<L>> {
    const { input, labels, instructions, fallback, threshold, ...call } = options;
    const question = toQuestion('label', labels as DecisionSpec, instructions);
    const { answers, meta } = await this.systemOne(input, { label: question }, 'classify', call);

    const effectiveThreshold = threshold ?? this.threshold;
    const result = toChoiceResult<L>(answers, 'label', meta, effectiveThreshold);

    if (fallback && !result.isConfident(effectiveThreshold)) {
      const chosen = await fallback({
        input,
        labels: (Array.isArray(labels) ? labels : Object.keys(labels)) as readonly L[],
        result,
        confidence: result.confidence,
        threshold: effectiveThreshold,
      });
      // The probabilities stay as Laya reported them: they describe Laya's view,
      // not the fallback's, and overwriting them would invent a number.
      result.label = chosen;
      result.meta = { ...result.meta, fallbackUsed: true };
    }

    return result;
  }

  /**
   * Answer several typed questions about one input in a single forward pass.
   * Each decision's result type follows the shape of its spec.
   */
  async decide<const D extends Record<string, DecisionSpec>>(
    options: DecideOptions<D>,
  ): Promise<DecideResults<D>> {
    const { input, decisions, threshold, ...call } = options;
    const names = Object.keys(decisions);
    if (names.length === 0) {
      throw new LayaValidationError('decide: `decisions` must contain at least one entry.');
    }

    const questions: Record<string, LayaQuestion> = {};
    for (const name of names) {
      questions[name] = toQuestion(name, decisions[name] as DecisionSpec);
    }

    const { answers, meta } = await this.systemOne(input, questions, 'decide', call);
    const effectiveThreshold = threshold ?? this.threshold;

    const results: Record<string, AnyResult> = {};
    for (const name of names) {
      results[name] = toResult(
        answers,
        name,
        specKind(decisions[name] as DecisionSpec),
        meta,
        effectiveThreshold,
      );
    }
    return results as DecideResults<D>;
  }

  /** Rate an input against an ordered rubric. Returns a fractional expected score. */
  async score(options: ScoreOptions): Promise<ScoreResult> {
    const { input, levels, instructions, threshold, ...call } = options;
    const question = toQuestion('score', { kind: 'score', levels, ...(instructions !== undefined ? { instructions } : {}) }, instructions);
    const { answers, meta } = await this.systemOne(input, { score: question }, 'score', call);
    return toScoreResult(answers, 'score', meta, threshold ?? this.threshold);
  }

  /**
   * Run several yes/no guardrail checks in one forward pass.
   *
   * A laya-studio convenience over N `noul` questions. Laya returns only a
   * probability per check; `passed` and `flagged` are computed here by
   * comparing each probability against `flagAt` (default 0.5).
   *
   * Useful as a cheap pre-filter for injection attempts, off-topic input or
   * policy violations — but see the security notes: Laya's output is a signal,
   * not an authorization boundary.
   */
  async screen<const C extends Record<string, string>>(
    options: ScreenOptions<C>,
  ): Promise<ScreenResult<C>> {
    const { input, checks, flagAt = 0.5, threshold, ...call } = options;
    const names = Object.keys(checks) as Array<keyof C & string>;
    if (names.length === 0) {
      throw new LayaValidationError('screen: `checks` must contain at least one check.');
    }

    const questions: Record<string, LayaQuestion> = {};
    for (const name of names) {
      questions[name] = toQuestion(name, { kind: 'noul', instructions: checks[name] as string });
    }

    const { answers, meta } = await this.systemOne(input, questions, 'screen', call);
    const effectiveThreshold = threshold ?? this.threshold;

    const results = {} as { [K in keyof C]: NoulResult };
    const flagged: Array<keyof C & string> = [];
    for (const name of names) {
      const result = toNoulResult(answers, name, meta, effectiveThreshold);
      results[name] = result;
      if (result.probability >= flagAt) flagged.push(name);
    }

    return { passed: flagged.length === 0, flagged, checks: results, meta };
  }

  /**
   * Decide whether two records describe the same thing.
   *
   * A laya-studio convenience, not a Laya primitive: it sends one `choice`
   * question over three verdicts with `{ a, b }` as the state. The verdicts
   * `same` / `different` / `unclear` are this SDK's default wording, not
   * Laya's — override them with `labels`, or use {@link Laya.predict} to write
   * the question yourself.
   */
  async match(options: MatchOptions): Promise<ChoiceResult<string> & { verdict: MatchVerdict }> {
    const { a, b, instructions, labels, threshold, ...call } = options;
    const verdicts = labels ?? (['same', 'different', 'unclear'] as const);
    const question = toQuestion(
      'match',
      {
        kind: 'choice',
        labels: verdicts as readonly string[],
        instructions:
          instructions ??
          'Do record A and record B refer to the same entity? Answer "unclear" if the evidence is insufficient.',
      },
      instructions,
    );
    const { answers, meta } = await this.systemOne({ a, b }, { match: question }, 'match', call);
    const result = toChoiceResult<string>(answers, 'match', meta, threshold ?? this.threshold);
    return Object.assign(result, { verdict: result.label as MatchVerdict });
  }

  /**
   * Score many inputs.
   *
   * The Laya HTTP API takes one state per request, so this issues one request
   * per item with bounded concurrency rather than a single batched call. It is
   * not fake batching: overlapping the requests is the whole of the available
   * win at the HTTP layer. To batch *work*, put several questions in one
   * `decide()` — those genuinely share a forward pass.
   */
  async batch<const D extends Record<string, DecisionSpec>>(
    items: readonly BatchItem<D>[],
    options: BatchOptions = {},
  ): Promise<BatchOutcome<D>[]> {
    if (items.length === 0) return [];
    const limit = options.concurrency ?? this.concurrency;
    // `concurrency` is consumed above; the rest are forwarded to each decide().
    const { throwOnError, ...rest } = options;
    delete (rest as { concurrency?: number }).concurrency;
    const call = rest;

    if (throwOnError) {
      const results = await mapWithConcurrency(items, limit, (item) =>
        this.decide({
          input: item.input,
          decisions: item.decisions,
          ...call,
          ...(item.model !== undefined ? { model: item.model } : {}),
        }),
      );
      return results.map((results_, index) => ({ ok: true as const, index, results: results_ }));
    }

    const settled = await settleWithConcurrency(items, limit, (item) =>
      this.decide({
        input: item.input,
        decisions: item.decisions,
        ...call,
        ...(item.model !== undefined ? { model: item.model } : {}),
      }),
    );

    return settled.map((outcome, index) =>
      outcome.ok
        ? { ok: true as const, index, results: outcome.value }
        : { ok: false as const, index, error: outcome.error },
    );
  }

  /**
   * Build a router that picks one of your registered handlers.
   * Only handlers you registered can run — see {@link LayaRouter}.
   */
  createRouter<H extends RouteHandlers>(options: RouterOptions<H>): LayaRouter<H> {
    return new LayaRouter(this, options);
  }

  /**
   * Answer a flat JSON Schema in one forward pass, decoding each answer back to
   * the schema's own type.
   *
   * A convenience over {@link Laya.predict}: every property compiles to one
   * Laya question — `enum` to `choice`, `boolean` to `noul`, a bounded
   * `integer`/`number` to `score`. Schemas Laya cannot express (free strings,
   * arrays, nested objects, `$ref`) are rejected here with the same message
   * Laya itself would give, rather than failing at the server.
   *
   * ```ts
   * const { values } = await laya.decideFromSchema({
   *   input: ticket,
   *   schema: {
   *     type: 'object',
   *     properties: {
   *       department: { enum: ['billing', 'technical'] },
   *       urgency: { type: 'integer', minimum: 0, maximum: 3 },
   *       isSpam: { type: 'boolean' },
   *     },
   *   },
   * });
   * values.department; // "billing"
   * values.urgency;    // 2
   * values.isSpam;     // false
   * ```
   */
  async decideFromSchema(options: SchemaDecisionOptions): Promise<SchemaDecisionResult> {
    const { input, schema, threshold, ...call } = options;

    const plan = planFromJsonSchema(schema);
    const questions: Record<string, LayaQuestion> = {};
    for (const field of plan) questions[field.name] = field.question;

    const { answers, meta } = await this.systemOne(input, questions, 'decideFromSchema', call);
    const effectiveThreshold = threshold ?? this.threshold;

    const values: Record<string, string | number | boolean | null> = {};
    const fields: Record<string, SchemaFieldResult> = {};
    const lowConfidence: string[] = [];

    for (const field of plan) {
      const answer = answers[field.name];
      if (!answer) {
        throw new LayaModelError(
          `Laya returned no answer for schema property "${field.name}".`,
        );
      }

      const value = decodeSchemaAnswer(field, answer);
      const confidence = answer.answer_confidence;
      const isConfident = (t: number = effectiveThreshold): boolean => confidence >= t;

      values[field.name] = value;
      fields[field.name] = { value, confidence, kind: field.kind, raw: answer, isConfident };
      if (!isConfident()) lowConfidence.push(field.name);
    }

    return { values, fields, lowConfidence, meta };
  }

  /** `GET /health`. Throws the same typed errors as any other call. */
  async health(options: { timeout?: number; signal?: AbortSignal } = {}): Promise<HealthResponse> {
    return this.transport.request<HealthResponse>({
      path: '/health',
      method: 'GET',
      ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  /**
   * Checkpoints the server currently has **loaded in memory**, read from
   * `/health`.
   *
   * Named for exactly what it returns. The Laya server exposes no model-listing
   * route, so this is not model discovery: a server that lazily loads its
   * checkpoints reports an empty list until it has served a request, and a
   * checkpoint absent here may still be usable. The names a request's `model`
   * field accepts are fixed and known at build time — see {@link KNOWN_MODELS}.
   */
  async loadedModels(options: { timeout?: number; signal?: AbortSignal } = {}): Promise<string[]> {
    const health = await this.health(options);
    return Array.isArray(health.loaded) ? health.loaded : [];
  }
}
