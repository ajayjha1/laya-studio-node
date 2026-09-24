/**
 * Wire types for the Laya HTTP server (`laya-serve`).
 *
 * These mirror `POST /v1/systemone` and `GET /health` exactly as implemented in
 * laya/serve.py and laya/agent.py. Nothing here is invented: every field is one
 * the server actually sends or accepts. Unknown fields are ignored by the
 * server, and we likewise tolerate extra fields coming back.
 *
 * @see https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py
 */

/** A state is free-form: plain text, or a JSON object/array the model serializes. */
export type LayaState = string | Record<string, unknown> | unknown[];

/** The three question primitives Laya understands. */
export type QuestionType = 'choice' | 'score' | 'noul';

/** `choice`: pick exactly one option. Criteria is label -> description, or a bare label list. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null> | string[];
}

/** `score`: an ordered rubric. Criteria is a list of level descriptions, index 0 first. */
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

/** `noul`: a yes/no judgement answered with P(yes). Criteria may only be keyed true/false. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
  labels?: [string, string] | Record<string, string>;
}

export type LayaQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/**
 * Output of Laya's act/escalate head, present on every answer.
 *
 * laya-studio forwards this verbatim and does not interpret it: no operation
 * here gates on `act_probability`, and no documented meaning is claimed for it
 * beyond what Laya's own model card states.
 */
export interface AnswerAction {
  act_probability: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  /**
   * Normalized Shannon entropy of the distribution, `1 - H(p)/log(k)`: how
   * concentrated the whole distribution is. **Not calibrated**, and on a
   * different scale from `answer_confidence` — Laya's source states the two
   * must not be compared against the same threshold.
   */
  confidence: number;
  /**
   * `max(p)` — the probability mass on the reported answer. This is the
   * calibrated quantity Laya fits temperature scaling on and measures ECE
   * against, and the one to gate decisions on.
   */
  answer_confidence: number;
  action: AnswerAction;
}

export interface ScoreAnswer {
  type: 'score';
  /** Expected value over the rubric levels, so fractional scores are normal. */
  score: number;
  /** Level index (as a string) -> the level description you supplied. */
  legend: Record<string, string>;
  /** Level index (as a string) -> probability. */
  probabilities: Record<string, number>;
  /** Normalized Shannon entropy. Not calibrated. See `answer_confidence`. */
  confidence: number;
  /** `max(p)`: the probability of the single most likely level. Calibrated. */
  answer_confidence: number;
  action: AnswerAction;
}

export interface NoulAnswer {
  type: 'noul';
  /** P(yes), in [0, 1]. Laya returns no boolean — only this probability. */
  noul: number;
  /** `max(p_yes, 1 - p_yes)`. For a two-option question this equals `answer_confidence`. */
  confidence: number;
  /** `max(p)`. Calibrated. Equal to `confidence` for noul questions. */
  answer_confidence: number;
  action: AnswerAction;
}

export type LayaAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/** Which checkpoint the server's Router picked, and why. Absent on direct-agent responses. */
export interface LayaRouting {
  model: string;
  repo?: string;
  reason?: string;
}

export interface LayaUsage {
  input_tokens: number;
  output_tokens: number;
}

/** The body of a successful `POST /v1/systemone`. */
export interface SystemOneResponse {
  model: string;
  answers: Record<string, LayaAnswer>;
  usage: LayaUsage;
  routing?: LayaRouting;
}

export interface SystemOneRequest {
  state: LayaState;
  questions: Record<string, LayaQuestion>;
  /** `english` | `multilingual` | `typed-decisions`, or a published HF id. Otherwise auto-routed. */
  model?: string;
}

/** The body of `GET /health`. */
export interface HealthResponse {
  status: string;
  loaded: string[];
  device: string;
}

/** Checkpoint names `laya-serve` honours in a request's `model` field. */
export const KNOWN_MODELS = ['english', 'multilingual', 'typed-decisions'] as const;
export type KnownModel = (typeof KNOWN_MODELS)[number];

/** Server-side request guardrails, mirrored so we can fail fast with a clear message. */
export const SERVER_LIMITS = {
  maxQuestions: 64,
  maxStateChars: 50_000,
  maxBodyBytes: 2 * 1024 * 1024,
} as const;
