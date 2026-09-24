import type { Laya, CallOptions } from '../client/laya.js';
import type { ChoiceResult, ResultMeta } from '../decisions/results.js';
import type { LayaState } from '../wire.js';
import { LayaValidationError } from '../errors/index.js';

export interface RouteContext {
  /** The route Laya selected. */
  route: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export type RouteHandler = (input: LayaState, context: RouteContext) => unknown;

export type RouteHandlers = Record<string, RouteHandler>;

export interface RouterFallbackContext<H extends RouteHandlers> {
  input: LayaState;
  /** The route Laya leaned towards, even though it was below threshold. */
  suggested: keyof H & string;
  confidence: number;
  threshold: number;
  probabilities: Record<string, number>;
}

export interface RouterOptions<H extends RouteHandlers> {
  /** Route name -> handler. Only these can ever be executed. */
  routes: H;
  /** Route name -> what belongs on it. Descriptions measurably improve routing. */
  descriptions?: Partial<Record<keyof H & string, string>>;
  /** Override the generated routing question. */
  instructions?: string;
  /** Minimum confidence to execute a handler. Defaults to the client's threshold. */
  threshold?: number;
  /** Called instead of a handler when confidence is below threshold. */
  fallback?: (context: RouterFallbackContext<H>) => unknown;
  model?: string;
}

export type RouterResult<H extends RouteHandlers> = {
  /** Which route ran, or `null` when nothing did. */
  route: (keyof H & string) | null;
  /** The route Laya picked, regardless of whether it was executed. */
  suggested: keyof H & string;
  confidence: number;
  probabilities: Record<string, number>;
  /** Whether a registered handler was executed. */
  handled: boolean;
  fallbackUsed: boolean;
  /** The handler's (or fallback's) return value. `undefined` when neither ran. */
  result: Awaited<ReturnType<H[keyof H]>> | unknown;
  /** The underlying classification, for logging or custom gating. */
  decision: ChoiceResult<keyof H & string>;
  meta: ResultMeta;
};

/**
 * Confidence-gated dispatch to handlers you registered.
 *
 * The model never names code to run. It returns one of the route keys supplied
 * at construction, and the handler is looked up in a `Map` built from those keys
 * — so no model output can reach `__proto__`, `constructor`, or any function
 * that was not explicitly registered here.
 */
export class LayaRouter<H extends RouteHandlers> {
  private readonly laya: Laya;
  private readonly handlers: Map<string, RouteHandler>;
  private readonly routeNames: Array<keyof H & string>;
  private readonly options: RouterOptions<H>;

  constructor(laya: Laya, options: RouterOptions<H>) {
    const names = Object.keys(options.routes) as Array<keyof H & string>;
    if (names.length === 0) {
      throw new LayaValidationError('createRouter: `routes` must contain at least one route.');
    }
    for (const name of names) {
      if (typeof options.routes[name] !== 'function') {
        throw new LayaValidationError(`createRouter: route "${name}" is not a function.`);
      }
    }

    this.laya = laya;
    this.options = options;
    this.routeNames = names;
    // A Map keyed by the registered names: lookup cannot walk the prototype chain.
    this.handlers = new Map(names.map((name) => [name, options.routes[name] as RouteHandler]));
  }

  /** The routes this router can dispatch to. */
  get routes(): Array<keyof H & string> {
    return [...this.routeNames];
  }

  async run(input: LayaState, callOptions: CallOptions = {}): Promise<RouterResult<H>> {
    const descriptions = this.options.descriptions;
    // Descriptions, when given, are sent as label -> description; otherwise a bare list.
    const labels: readonly string[] | Record<string, string> = descriptions
      ? Object.fromEntries(this.routeNames.map((name) => [name, descriptions[name] ?? name]))
      : this.routeNames;

    const threshold = callOptions.threshold ?? this.options.threshold ?? this.laya.threshold;

    const decision = (await this.laya.classify({
      input,
      labels: labels as readonly string[],
      ...(this.options.instructions !== undefined
        ? { instructions: this.options.instructions }
        : { instructions: `Which handler should process this? Options: ${this.routeNames.join(', ')}.` }),
      ...callOptions,
      threshold,
      ...(callOptions.model !== undefined
        ? { model: callOptions.model }
        : this.options.model !== undefined
          ? { model: this.options.model }
          : {}),
    })) as ChoiceResult<keyof H & string>;

    const suggested = decision.label;
    const base = {
      suggested,
      confidence: decision.confidence,
      probabilities: decision.probabilities as Record<string, number>,
      decision,
      meta: decision.meta,
    };

    if (!decision.isConfident(threshold)) {
      if (this.options.fallback) {
        const result = await this.options.fallback({
          input,
          suggested,
          confidence: decision.confidence,
          threshold,
          probabilities: decision.probabilities as Record<string, number>,
        });
        return { ...base, route: null, handled: false, fallbackUsed: true, result };
      }
      // No fallback: report the low-confidence outcome rather than guessing.
      return { ...base, route: null, handled: false, fallbackUsed: false, result: undefined };
    }

    const handler = this.handlers.get(suggested);
    if (!handler) {
      // Only reachable if the server answered with a label outside the schema.
      return { ...base, route: null, handled: false, fallbackUsed: false, result: undefined };
    }

    const result = await handler(input, {
      route: suggested,
      confidence: decision.confidence,
      probabilities: decision.probabilities as Record<string, number>,
    });

    return { ...base, route: suggested, handled: true, fallbackUsed: false, result };
  }
}
