import type { LayaQuestion } from '../wire.js';
import { LayaValidationError } from '../errors/index.js';

/** Labels as a bare list, or as label -> description (descriptions improve accuracy). */
export type LabelSpec = readonly string[] | Readonly<Record<string, string>>;

/** Extract the literal union of labels from a {@link LabelSpec}. */
export type LabelsOf<S> = S extends readonly (infer U)[]
  ? U extends string
    ? U
    : never
  : S extends Readonly<Record<infer K, string>>
    ? K extends string
      ? K
      : never
    : never;

export interface ChoiceSpec<L extends string = string> {
  kind: 'choice';
  labels: readonly L[] | Readonly<Record<L, string>>;
  instructions?: string;
}

export interface ScoreSpec {
  kind: 'score';
  /** Ordered level descriptions, lowest first. Laya allows 2–10 levels. */
  levels: readonly string[];
  instructions?: string;
}

export interface NoulSpec {
  kind: 'noul';
  /** The yes/no question the model answers with P(yes). */
  instructions: string;
  whenTrue?: string;
  whenFalse?: string;
}

/**
 * One decision in a {@link import('../client/laya.js').Laya.decide} call.
 * A bare array or object is shorthand for a choice question.
 */
export type DecisionSpec = LabelSpec | ChoiceSpec<string> | ScoreSpec | NoulSpec;

/** Build a choice decision with optional custom instructions. */
export function choice<const L extends string>(
  labels: readonly L[] | Readonly<Record<L, string>>,
  instructions?: string,
): ChoiceSpec<L> {
  return instructions === undefined ? { kind: 'choice', labels } : { kind: 'choice', labels, instructions };
}

/** Build an ordered-rubric decision. */
export function score(levels: readonly string[], instructions?: string): ScoreSpec {
  return instructions === undefined ? { kind: 'score', levels } : { kind: 'score', levels, instructions };
}

/** Build a yes/no decision. */
export function noul(instructions: string, options: { whenTrue?: string; whenFalse?: string } = {}): NoulSpec {
  return { kind: 'noul', instructions, ...options };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function specKind(spec: DecisionSpec): 'choice' | 'score' | 'noul' {
  if (Array.isArray(spec)) return 'choice';
  if (isRecord(spec) && typeof spec.kind === 'string') {
    const kind = spec.kind;
    if (kind === 'choice' || kind === 'score' || kind === 'noul') return kind;
  }
  return 'choice';
}

/** The labels a choice spec will produce, in the order the server sees them. */
export function labelsOfSpec(spec: LabelSpec | ChoiceSpec<string>): string[] {
  if (Array.isArray(spec)) return [...(spec as readonly string[])];
  if (isRecord(spec) && spec.kind === 'choice') {
    const { labels } = spec as unknown as ChoiceSpec<string>;
    return Array.isArray(labels) ? [...labels] : Object.keys(labels);
  }
  return Object.keys(spec as Readonly<Record<string, string>>);
}

/**
 * Compile a decision spec into the exact question shape `/v1/systemone` accepts.
 *
 * Validation happens here rather than at the server so a mistake surfaces with
 * the decision's own name, before a network round trip.
 */
export function toQuestion(name: string, spec: DecisionSpec, defaultInstructions?: string): LayaQuestion {
  const kind = specKind(spec);

  if (kind === 'score') {
    const { levels, instructions } = spec as ScoreSpec;
    if (!Array.isArray(levels) || levels.length < 2) {
      throw new LayaValidationError(
        `Decision "${name}": a score question needs at least 2 ordered levels, lowest first. ` +
          `Laya supports 2–10.`,
      );
    }
    return {
      type: 'score',
      instructions: instructions ?? defaultInstructions ?? `Rate: ${name}`,
      criteria: [...levels],
    };
  }

  if (kind === 'noul') {
    const { instructions, whenTrue, whenFalse } = spec as NoulSpec;
    if (typeof instructions !== 'string' || instructions.trim() === '') {
      throw new LayaValidationError(`Decision "${name}": a noul question needs non-empty instructions.`);
    }
    const question: LayaQuestion = { type: 'noul', instructions };
    // The server accepts `criteria` keyed only true/false; anything else is a 422.
    if (whenTrue !== undefined || whenFalse !== undefined) {
      question.criteria = {
        ...(whenTrue !== undefined ? { true: whenTrue } : {}),
        ...(whenFalse !== undefined ? { false: whenFalse } : {}),
      };
    }
    return question;
  }

  const choiceSpec = spec as LabelSpec | ChoiceSpec<string>;
  const rawLabels =
    isRecord(choiceSpec) && 'kind' in choiceSpec ? choiceSpec.labels : (choiceSpec as LabelSpec);
  const instructions =
    isRecord(choiceSpec) && 'kind' in choiceSpec ? choiceSpec.instructions : undefined;

  const labels = labelsOfSpec(choiceSpec);
  if (labels.length === 0) {
    throw new LayaValidationError(`Decision "${name}": a choice question needs at least one label.`);
  }
  const seen = new Set<string>();
  for (const label of labels) {
    if (typeof label !== 'string' || label.trim() === '') {
      throw new LayaValidationError(`Decision "${name}": labels must be non-empty strings.`);
    }
    if (seen.has(label)) {
      throw new LayaValidationError(
        `Decision "${name}": duplicate label ${JSON.stringify(label)}. ` +
          `Laya returns one probability per label, so labels must be unique.`,
      );
    }
    seen.add(label);
  }

  return {
    type: 'choice',
    instructions: instructions ?? defaultInstructions ?? `Which option best describes this? (${name})`,
    // Descriptions are sent through untouched; a bare list stays a list, which
    // the server normalizes to {label: null}.
    criteria: Array.isArray(rawLabels)
      ? [...(rawLabels as readonly string[])]
      : ({ ...(rawLabels as Record<string, string>) } as Record<string, string>),
  };
}
