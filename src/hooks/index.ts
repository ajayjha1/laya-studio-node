/**
 * Observability hooks.
 *
 * Deliberately metadata-only: no hook receives the state text or the answers.
 * Logging user input is a decision an application makes on purpose, never a
 * side effect of turning on observability.
 */

export interface RequestMetadata {
  requestId: string;
  /** The operation that triggered the call: `classify`, `decide`, `route`, … */
  operation: string;
  /** Checkpoint pinned by the caller for this request, if any. */
  model?: string;
  /** Number of questions in the request — the unit Laya actually batches. */
  questionCount: number;
  endpoint: string;
}

export interface ResponseMetadata extends RequestMetadata {
  latencyMs: number;
  /**
   * The server's `model` field verbatim — a model family id (Laya reports the
   * constant `"laya-rl-agent"`), NOT the checkpoint that answered.
   */
  reportedModel?: string;
  /** The checkpoint that answered, read from the server's `routing.model`. */
  checkpoint?: string;
  cached: boolean;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ErrorMetadata extends RequestMetadata {
  latencyMs: number;
  error: unknown;
}

export interface LayaHooks {
  onRequest?: (meta: RequestMetadata) => void | Promise<void>;
  onResponse?: (meta: ResponseMetadata) => void | Promise<void>;
  onError?: (meta: ErrorMetadata) => void | Promise<void>;
}

/**
 * Run a hook without letting it break the caller's request.
 *
 * A broken metrics sink must not fail an inference that already succeeded, so
 * throws and rejections are swallowed and reported on stderr.
 */
export async function emit<M>(
  hook: ((meta: M) => void | Promise<void>) | undefined,
  meta: M,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(meta);
  } catch (error) {
    console.error('[laya-studio] hook threw and was ignored:', error);
  }
}
