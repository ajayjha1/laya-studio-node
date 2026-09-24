/**
 * Schema-driven decisions: turn a JSON Schema into Laya questions.
 *
 * The mapping rules — and, just as importantly, the **refusals** — mirror
 * Laya's own `laya/structured.py`. A schema this module rejects is one Laya
 * would reject too, and the messages say the same thing, so nothing is
 * silently accepted here that would fail server-side.
 *
 * @see https://github.com/NandhaKishorM/laya/blob/main/laya/structured.py
 */

import { LayaValidationError } from '../errors/index.js';
import type { LayaQuestion } from '../wire.js';

/** Laya caps a choice question's option count. */
export const MAX_OPTIONS = 255;
/** Laya caps a score question's level count. */
export const MAX_SCORE_LEVELS = 10;

/** The subset of JSON Schema that maps onto Laya's three question types. */
export interface JsonSchemaProperty {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
}

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

/** One planned field: the question to ask, and how to read its answer back. */
export interface PlannedField {
  name: string;
  kind: 'choice' | 'score' | 'noul';
  question: LayaQuestion;
  /** For choice: label -> the original (possibly non-string) schema value. */
  options?: Array<[string, unknown]>;
  /** For score: the schema's `minimum`, so the level index maps back to a number. */
  minimum?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function enumField(
  path: string,
  name: string,
  values: readonly unknown[],
  description: string | undefined,
): PlannedField {
  if (values.length > MAX_OPTIONS) {
    throw new LayaValidationError(
      `${path}: ${values.length} options exceeds MAX_OPTIONS=${MAX_OPTIONS}`,
    );
  }
  if (values.length === 0) {
    throw new LayaValidationError(`${path}: 'enum' must not be empty`);
  }
  // An enum of only booleans is a yes/no question, not a two-option choice.
  if (values.every((value) => typeof value === 'boolean')) {
    return noulField(name, description);
  }

  const options: Array<[string, unknown]> = values.map((value) => [
    value === null ? 'null' : String(value),
    value,
  ]);

  return {
    name,
    kind: 'choice',
    options,
    question: {
      type: 'choice',
      instructions: description ?? `What is \`${name}\`?`,
      criteria: options.map(([label]) => label),
    },
  };
}

function noulField(name: string, description: string | undefined): PlannedField {
  return {
    name,
    kind: 'noul',
    question: {
      type: 'noul',
      instructions: description ?? `Is \`${name}\` true?`,
    },
  };
}

function scoreField(
  path: string,
  name: string,
  property: JsonSchemaProperty,
  description: string | undefined,
): PlannedField {
  const { minimum, maximum } = property;
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum)) {
    throw new LayaValidationError(
      `${path}: a numeric field needs integer 'minimum' and 'maximum' to become a score`,
    );
  }
  const lo = minimum as number;
  const hi = maximum as number;
  if (hi < lo) {
    throw new LayaValidationError(`${path}: 'maximum' ${hi} is below 'minimum' ${lo}`);
  }

  const span = hi - lo + 1;
  if (span > MAX_SCORE_LEVELS) {
    throw new LayaValidationError(
      `${path}: ${span} levels exceeds MAX_SCORE_LEVELS=${MAX_SCORE_LEVELS}; ` +
        `narrow the range or use an enum`,
    );
  }

  const levels: string[] = [];
  for (let value = lo; value <= hi; value++) levels.push(String(value));

  return {
    name,
    kind: 'score',
    minimum: lo,
    question: {
      type: 'score',
      instructions: description ?? `Score \`${name}\` from ${lo} to ${hi}`,
      criteria: levels,
    },
  };
}

/** Plan one property. Throws with Laya's own wording for anything unsupported. */
export function planField(path: string, name: string, property: JsonSchemaProperty): PlannedField {
  if (!isRecord(property)) {
    throw new LayaValidationError(
      `${path}: property must be an object, got ${typeof property}`,
    );
  }

  const description = typeof property.description === 'string' ? property.description : undefined;

  if ('const' in property) return enumField(path, name, [property.const], description);
  if ('enum' in property) {
    if (!Array.isArray(property.enum)) {
      throw new LayaValidationError(`${path}: 'enum' must be an array`);
    }
    return enumField(path, name, property.enum, description);
  }

  // A nullable type such as ["string", "null"] is read as its non-null member.
  let jsonType = property.type;
  if (Array.isArray(jsonType)) {
    jsonType = jsonType.find((entry) => entry !== 'null');
  }

  if (jsonType === 'boolean') return noulField(name, description);
  if (jsonType === 'string') {
    throw new LayaValidationError(
      `${path}: a free string cannot be a fixed option set; use 'enum' or a boolean`,
    );
  }
  if (jsonType === 'integer' || jsonType === 'number') {
    return scoreField(path, name, property, description);
  }
  if (jsonType === 'array') {
    throw new LayaValidationError(`${path}: arrays are not supported; ask one field per element`);
  }
  if (jsonType === 'object') {
    throw new LayaValidationError(`${path}: nested objects are not supported; flatten the schema`);
  }
  if ('$ref' in property) {
    throw new LayaValidationError(`${path}: $ref/recursion is not supported; flatten the schema`);
  }

  throw new LayaValidationError(`${path}: unsupported schema ${JSON.stringify(property)}`);
}

/** Validate a JSON Schema object and return one planned field per property. */
export function planFromJsonSchema(schema: JsonSchemaObject): PlannedField[] {
  if (!isRecord(schema)) {
    throw new LayaValidationError('schema must be an object');
  }
  const properties = schema.properties;
  if (!isRecord(properties)) {
    throw new LayaValidationError(
      "schema must have a 'properties' object describing each decision",
    );
  }

  const names = Object.keys(properties);
  if (names.length === 0) {
    throw new LayaValidationError("schema 'properties' must contain at least one property");
  }

  return names.map((name) =>
    planField(`properties.${name}`, name, properties[name] as JsonSchemaProperty),
  );
}

/** Compile a JSON Schema straight into the questions `/v1/systemone` accepts. */
export function questionsFromJsonSchema(
  schema: JsonSchemaObject,
): Record<string, LayaQuestion> {
  const questions: Record<string, LayaQuestion> = {};
  for (const field of planFromJsonSchema(schema)) questions[field.name] = field.question;
  return questions;
}

/**
 * Convert one Laya answer back to the type the schema asked for.
 *
 * `choice` returns the original enum value (which may be a number, boolean or
 * null, not just its label); `score` maps the level index back through the
 * schema's `minimum`; `noul` becomes a boolean at the documented 0.5 cutoff.
 */
export function decodeSchemaAnswer(
  field: PlannedField,
  answer: { type: string; choice?: string; score?: number; noul?: number },
): string | number | boolean | null {
  if (field.kind === 'choice') {
    const label = answer.choice ?? '';
    const match = field.options?.find(([optionLabel]) => optionLabel === label);
    // Fall back to the raw label if the server answered outside the option set.
    return match ? (match[1] as string | number | boolean | null) : label;
  }

  if (field.kind === 'score') {
    // `score` is an expected value; round it to the nearest level, then shift
    // by `minimum` so the number means what the schema said it means.
    const expected = answer.score ?? 0;
    return Math.round(expected) + (field.minimum ?? 0);
  }

  return (answer.noul ?? 0) > 0.5;
}
