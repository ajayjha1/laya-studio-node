/**
 * laya-studio — Node.js/TypeScript toolkit for using Laya as a fast decision
 * layer in AI applications.
 *
 * @see https://huggingface.co/convaiinnovations/laya
 */

export { Laya } from './client/laya.js';
export type {
  CallOptions,
  PredictOptions,
  PredictResult,
  ClassifyOptions,
  ClassifyFallback,
  FallbackContext,
  DecideOptions,
  ScoreOptions,
  ScreenOptions,
  ScreenResult,
  MatchOptions,
  MatchVerdict,
  BatchItem,
  BatchOptions,
  BatchOutcome,
  SchemaDecisionOptions,
  SchemaDecisionResult,
  SchemaFieldResult,
} from './client/laya.js';

export { LayaRouter } from './router/router.js';
export type {
  RouteContext,
  RouteHandler,
  RouteHandlers,
  RouterOptions,
  RouterResult,
  RouterFallbackContext,
} from './router/router.js';

export { choice, score, noul } from './decisions/spec.js';
export { presets, triage, email, guard, moderation, router, PRESET_NAMES } from './decisions/presets.js';
export type { PresetDecisions, PresetName } from './decisions/presets.js';
export {
  planFromJsonSchema,
  questionsFromJsonSchema,
  decodeSchemaAnswer,
  MAX_OPTIONS,
  MAX_SCORE_LEVELS,
} from './decisions/schema.js';
export type { JsonSchemaObject, JsonSchemaProperty, PlannedField } from './decisions/schema.js';
export { validateQuestions } from './decisions/validate.js';
export type {
  ChoiceSpec,
  ScoreSpec,
  NoulSpec,
  DecisionSpec,
  LabelSpec,
  LabelsOf,
} from './decisions/spec.js';

export type {
  ChoiceResult,
  ScoreResult,
  NoulResult,
  AnyResult,
  ResultFor,
  DecideResults,
  ResultMeta,
  ConfidenceMethods,
} from './decisions/results.js';

export { defineConfig, configFromEnv, resolveConfig, DEFAULTS } from './config.js';
export type { LayaConfig, CacheOptions } from './config.js';

export { HttpTransport } from './transport/index.js';
export type { LayaTransport, TransportRequest } from './transport/index.js';

export { MemoryCache } from './cache/index.js';
export type { LayaCache } from './cache/index.js';

export type {
  LayaHooks,
  RequestMetadata,
  ResponseMetadata,
  ErrorMetadata,
} from './hooks/index.js';

export {
  LayaError,
  LayaConnectionError,
  LayaTimeoutError,
  LayaValidationError,
  LayaInferenceError,
  LayaModelError,
  LayaAuthError,
  isLayaError,
} from './errors/index.js';
export type { LayaErrorCode } from './errors/index.js';

export { evaluate, summarize } from './eval/metrics.js';
export type {
  EvalRow,
  EvalPrediction,
  EvalReport,
  LabelMetrics,
  ThresholdPoint,
} from './eval/metrics.js';

export { KNOWN_MODELS, SERVER_LIMITS } from './wire.js';
export type {
  LayaState,
  LayaQuestion,
  LayaAnswer,
  ChoiceAnswer,
  ScoreAnswer,
  NoulAnswer,
  ChoiceQuestion,
  ScoreQuestion,
  NoulQuestion,
  QuestionType,
  SystemOneRequest,
  SystemOneResponse,
  HealthResponse,
  LayaRouting,
  LayaUsage,
  KnownModel,
} from './wire.js';
