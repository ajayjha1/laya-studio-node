import type { Laya, AnyResult, DecisionSpec } from '../src/index.js';
import { isLayaError } from '../src/index.js';
import { textResult, type ToolDefinition, type ToolResult } from './protocol.js';

const stateSchema = {
  description: 'The text to evaluate. A JSON object is also accepted for structured records.',
  anyOf: [{ type: 'string' }, { type: 'object' }],
} as const;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'laya_predict',
    description:
      'The canonical Laya call: send raw typed questions and get raw answers back. Use this when ' +
      'a question shape is not covered by the other tools. Each question is choice (one of N ' +
      'labels), score (ordered rubric) or noul (yes/no probability); all questions in one call ' +
      'are answered in a single forward pass.',
    inputSchema: {
      type: 'object',
      properties: {
        state: stateSchema,
        questions: {
          type: 'object',
          description: 'Question name -> definition, exactly as the Laya API accepts.',
          minProperties: 1,
          maxProperties: 64,
          additionalProperties: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['choice', 'score', 'noul'] },
              instructions: { type: 'string', description: 'The question the model answers.' },
              criteria: {
                description:
                  'choice: {label: description} or [label, …]. score: [level0, level1, …], ' +
                  'lowest first. noul: optional {true?, false?} only.',
                anyOf: [{ type: 'object' }, { type: 'array', items: { type: 'string' } }],
              },
            },
            required: ['type', 'instructions'],
          },
        },
      },
      required: ['state', 'questions'],
      additionalProperties: false,
    },
  },
  {
    name: 'laya_classify',
    description:
      'Assign exactly one label to a piece of text, with a probability for every label. ' +
      'A convenience wrapper over laya_predict that sends a single choice question. ' +
      'Cannot return a label outside the list you give it. Confidence is Laya\'s ' +
      'answer_confidence (= max probability), which is the calibrated number to gate on.',
    inputSchema: {
      type: 'object',
      properties: {
        input: stateSchema,
        labels: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 255,
          description: 'The candidate labels. Exactly one is returned.',
        },
        descriptions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Optional label -> description map. Describing each label measurably improves accuracy.',
        },
        instructions: {
          type: 'string',
          description: 'Optional question text shown to the model.',
        },
      },
      required: ['input', 'labels'],
      additionalProperties: false,
    },
  },
  {
    name: 'laya_decide',
    description:
      'Answer several typed questions about one input in a SINGLE forward pass — this is the ' +
      'genuine batching primitive, since Laya answers every question in a call together. Each ' +
      'decision is a choice (one of N labels), a score (ordered rubric, returns an expected ' +
      'value) or a noul (yes/no, returns P(yes)).',
    inputSchema: {
      type: 'object',
      properties: {
        input: stateSchema,
        decisions: {
          type: 'object',
          description: 'Decision name -> specification.',
          additionalProperties: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['choice', 'score', 'noul'] },
              labels: {
                type: 'array',
                items: { type: 'string' },
                description: 'For type=choice: the candidate labels.',
              },
              levels: {
                type: 'array',
                items: { type: 'string' },
                description: 'For type=score: ordered level descriptions, lowest first (2-10).',
              },
              instructions: {
                type: 'string',
                description: 'The question. Required for type=noul.',
              },
            },
            required: ['type'],
          },
          minProperties: 1,
          maxProperties: 64,
        },
      },
      required: ['input', 'decisions'],
      additionalProperties: false,
    },
  },
  {
    name: 'laya_route',
    description:
      'Choose which named route or handler should process an input, with a confidence score. ' +
      'A convenience wrapper over laya_predict sending one choice question over the route names. ' +
      'This only REPORTS the choice and never executes anything. Unrelated to Laya\'s internal ' +
      'checkpoint router, which picks english/multilingual/typed-decisions on the server.',
    inputSchema: {
      type: 'object',
      properties: {
        input: stateSchema,
        routes: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          description: 'The route names to choose between.',
        },
        descriptions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional route -> description map.',
        },
        threshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence required before the route is reported as actionable.',
        },
      },
      required: ['input', 'routes'],
      additionalProperties: false,
    },
  },
  {
    name: 'laya_screen',
    description:
      'Run yes/no guardrail checks over an input in one forward pass — prompt injection, ' +
      'off-topic content, policy checks. A convenience wrapper over laya_predict sending one ' +
      'noul question per check. Laya returns only a probability per check; passed/flagged are ' +
      'computed by comparing each against flagAt (default 0.5). A screening signal, NOT an ' +
      'authorization decision.',
    inputSchema: {
      type: 'object',
      properties: {
        input: stateSchema,
        checks: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Check name -> the yes/no question that flags it.',
          minProperties: 1,
          maxProperties: 64,
        },
        flagAt: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'A check fires at or above this probability. Default 0.5.',
        },
      },
      required: ['input', 'checks'],
      additionalProperties: false,
    },
  },
  {
    name: 'laya_batch',
    description:
      'Classify many inputs with the same labels. This is CLIENT-SIDE CONCURRENCY, not server ' +
      'or GPU batching: the Laya HTTP API takes one input per request, so each input is a ' +
      'separate request and a separate forward pass. To batch work in the model, put several ' +
      'questions in one laya_decide call instead.',
    inputSchema: {
      type: 'object',
      properties: {
        inputs: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 500,
        },
        labels: { type: 'array', items: { type: 'string' }, minItems: 2 },
        concurrency: { type: 'integer', minimum: 1, maximum: 32 },
      },
      required: ['inputs', 'labels'],
      additionalProperties: false,
    },
  },
  {
    name: 'laya_health',
    description:
      'Check that the Laya server is reachable and report which checkpoints are loaded in ' +
      'memory right now. This is GET /health, not model discovery: Laya exposes no ' +
      'model-listing route, and a lazily-loading server reports none until it serves a request.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

type Args = Record<string, unknown>;

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  throw new Error(`"${key}" is required and must be a string or object.`);
}

function requireStringArray(args: Args, key: string, minimum = 2): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`"${key}" must be an array of strings.`);
  }
  if (value.length < minimum) throw new Error(`"${key}" needs at least ${minimum} entries.`);
  return value as string[];
}

function optionalRecord(args: Args, key: string): Record<string, string> | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`"${key}" must be an object of string values.`);
  }
  const record: Record<string, string> = {};
  for (const [name, description] of Object.entries(value as Record<string, unknown>)) {
    if (typeof description !== 'string') throw new Error(`"${key}.${name}" must be a string.`);
    record[name] = description;
  }
  return record;
}

/** Plain, model-readable view of a result. */
function serialize(result: AnyResult): Record<string, unknown> {
  if (result.raw.type === 'choice') {
    const choice = result as { label: string; confidence: number; probabilities: Record<string, number> };
    return {
      type: 'choice',
      label: choice.label,
      confidence: choice.confidence,
      probabilities: choice.probabilities,
    };
  }
  if (result.raw.type === 'score') {
    const scored = result as { score: number; level: number; label: string; confidence: number };
    return {
      type: 'score',
      // Laya's expected value over the levels; fractional results are normal.
      score: scored.score,
      // `level` is the argmax of the level probabilities, computed by this SDK.
      level: scored.level,
      levelDescription: scored.label,
      // Probability of the most likely level — not a precision claim about `score`.
      confidence: scored.confidence,
    };
  }
  const noulResult = result as { value: boolean; probability: number; confidence: number };
  return {
    type: 'noul',
    // `answer` is derived from probabilityYes at a 0.5 cutoff chosen by this SDK;
    // Laya returns only the probability.
    answer: noulResult.value ? 'yes' : 'no',
    probabilityYes: noulResult.probability,
    confidence: noulResult.confidence,
  };
}

/**
 * Execute a tool by name.
 *
 * The dispatch table is a plain switch over known names — no dynamic lookup and
 * no shell access, so a client cannot reach anything that is not defined here.
 */
export async function callTool(laya: Laya, name: string, args: Args): Promise<ToolResult> {
  try {
    switch (name) {
      case 'laya_predict': {
        const state = requireString(args, 'state');
        const questions = args.questions;
        if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
          throw new Error('"questions" must be an object of question definitions.');
        }
        // predict() validates against the server's own rules before sending.
        const result = await laya.predict({
          state,
          questions: questions as Record<string, never>,
        });
        return textResult({
          model: result.model,
          answers: result.answers,
          usage: result.usage,
          routing: result.routing,
        });
      }

      case 'laya_classify': {
        const input = requireString(args, 'input');
        const labels = requireStringArray(args, 'labels');
        const descriptions = optionalRecord(args, 'descriptions');
        const instructions = args.instructions;

        const result = await laya.classify({
          input,
          labels: descriptions
            ? (Object.fromEntries(labels.map((l) => [l, descriptions[l] ?? l])) as Record<string, string>)
            : labels,
          ...(typeof instructions === 'string' ? { instructions } : {}),
        });

        return textResult({
          label: result.label,
          confidence: result.confidence,
          probabilities: result.probabilities,
          // The checkpoint that answered; `model` is a family id, not a checkpoint.
          checkpoint: result.meta.checkpoint ?? null,
          latencyMs: Math.round(result.meta.latencyMs),
        });
      }

      case 'laya_decide': {
        const input = requireString(args, 'input');
        const raw = args.decisions;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error('"decisions" must be an object of decision specifications.');
        }

        const decisions: Record<string, DecisionSpec> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          const spec = value as Record<string, unknown>;
          const type = spec.type;
          if (type === 'choice') {
            const labels = spec.labels;
            if (!Array.isArray(labels) || labels.length < 1) {
              throw new Error(`decision "${key}": type=choice needs a "labels" array.`);
            }
            decisions[key] = {
              kind: 'choice',
              labels: labels as string[],
              ...(typeof spec.instructions === 'string' ? { instructions: spec.instructions } : {}),
            };
          } else if (type === 'score') {
            const levels = spec.levels;
            if (!Array.isArray(levels) || levels.length < 2) {
              throw new Error(`decision "${key}": type=score needs a "levels" array of 2 or more.`);
            }
            decisions[key] = {
              kind: 'score',
              levels: levels as string[],
              ...(typeof spec.instructions === 'string' ? { instructions: spec.instructions } : {}),
            };
          } else if (type === 'noul') {
            if (typeof spec.instructions !== 'string' || spec.instructions.trim() === '') {
              throw new Error(`decision "${key}": type=noul needs "instructions".`);
            }
            decisions[key] = { kind: 'noul', instructions: spec.instructions };
          } else {
            throw new Error(`decision "${key}": type must be "choice", "score" or "noul".`);
          }
        }

        const results = (await laya.decide({ input, decisions })) as unknown as Record<string, AnyResult>;
        return textResult(
          Object.fromEntries(Object.entries(results).map(([key, value]) => [key, serialize(value)])),
        );
      }

      case 'laya_route': {
        const input = requireString(args, 'input');
        const routes = requireStringArray(args, 'routes');
        const descriptions = optionalRecord(args, 'descriptions');
        const threshold = typeof args.threshold === 'number' ? args.threshold : laya.threshold;

        const result = await laya.classify({
          input,
          labels: descriptions
            ? (Object.fromEntries(routes.map((r) => [r, descriptions[r] ?? r])) as Record<string, string>)
            : routes,
          instructions: `Which handler should process this? Options: ${routes.join(', ')}.`,
          threshold,
        });

        return textResult({
          route: result.isConfident(threshold) ? result.label : null,
          suggested: result.label,
          confident: result.isConfident(threshold),
          threshold,
          confidence: result.confidence,
          probabilities: result.probabilities,
          note: 'This reports the routing decision only. Nothing was executed.',
        });
      }

      case 'laya_screen': {
        const input = requireString(args, 'input');
        const checks = optionalRecord(args, 'checks');
        if (!checks || Object.keys(checks).length === 0) {
          throw new Error('"checks" must contain at least one check.');
        }
        const flagAt = typeof args.flagAt === 'number' ? args.flagAt : 0.5;
        const result = await laya.screen({ input, checks, flagAt });

        return textResult({
          passed: result.passed,
          flagged: result.flagged,
          checks: Object.fromEntries(
            Object.entries(result.checks).map(([key, value]) => [
              key,
              { answer: value.value ? 'yes' : 'no', probabilityYes: value.probability },
            ]),
          ),
          note: 'A screening signal, not an authorization decision.',
        });
      }

      case 'laya_batch': {
        const inputs = requireStringArray(args, 'inputs', 1);
        const labels = requireStringArray(args, 'labels');
        const concurrency = typeof args.concurrency === 'number' ? args.concurrency : 8;

        const outcomes = await laya.batch(
          inputs.map((input) => ({ input, decisions: { label: labels } })),
          { concurrency },
        );

        return textResult(
          outcomes.map((outcome, index) =>
            outcome.ok
              ? {
                  index,
                  input: inputs[index],
                  label: outcome.results.label.label,
                  confidence: outcome.results.label.confidence,
                }
              : { index, input: inputs[index], error: (outcome.error as Error).message },
          ),
        );
      }

      case 'laya_health': {
        const health = await laya.health();
        return textResult({ endpoint: laya.endpoint, ...health });
      }

      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (error) {
    // Laya's own errors already explain what to do; keep that text intact.
    const message = isLayaError(error)
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
    return textResult(message, true);
  }
}
