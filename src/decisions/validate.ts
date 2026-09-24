import { LayaValidationError } from '../errors/index.js';
import type { LayaQuestion } from '../wire.js';

/**
 * Validate raw questions against the rules the Laya server enforces.
 *
 * `predict()` is a passthrough, so these are exactly the server's own rules
 * (from `Agent._validate` in laya/agent.py) — checked here only so a mistake
 * surfaces immediately, with the question's name, instead of costing a round
 * trip and coming back as an HTTP 422.
 */
export function validateQuestions(questions: Record<string, LayaQuestion>): void {
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
    throw new LayaValidationError('predict: `questions` must be an object of question definitions.');
  }

  for (const [name, question] of Object.entries(questions)) {
    if (typeof question !== 'object' || question === null) {
      throw new LayaValidationError(`Question "${name}": definition must be an object.`);
    }

    const { type } = question;
    if (type !== 'choice' && type !== 'score' && type !== 'noul') {
      throw new LayaValidationError(
        `Question "${name}": unknown type ${JSON.stringify(type)}; use "choice", "score" or "noul".`,
      );
    }

    if (typeof question.instructions !== 'string' || question.instructions.trim() === '') {
      throw new LayaValidationError(
        `Question "${name}": no "instructions"; add the text the model should answer.`,
      );
    }

    if (type === 'choice') {
      const { criteria } = question;
      const isList = Array.isArray(criteria);
      const isMap = typeof criteria === 'object' && criteria !== null && !isList;
      if (!isList && !isMap) {
        throw new LayaValidationError(
          `Question "${name}": a choice question takes "criteria" as a dict of ` +
            `label -> description, or a list of labels.`,
        );
      }
      const labels = isList ? criteria : Object.keys(criteria);
      if (labels.length === 0) {
        throw new LayaValidationError(`Question "${name}": a choice question needs at least one criterion.`);
      }
      continue;
    }

    if (type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length === 0) {
        throw new LayaValidationError(
          `Question "${name}": a score question takes "criteria" as a list of level ` +
            `descriptions, index 0 first.`,
        );
      }
      continue;
    }

    // noul: `criteria` is optional, and may be keyed only true/false. Anything
    // else was historically dropped silently, so the server now rejects it.
    const { criteria } = question;
    if (criteria === undefined || criteria === null) continue;
    if (typeof criteria !== 'object' || Array.isArray(criteria)) {
      throw new LayaValidationError(
        `Question "${name}": a noul question takes "criteria" as an object with optional ` +
          `"true"/"false" descriptions, or omits it.`,
      );
    }
    const keys = Object.keys(criteria).map((key) => key.toLowerCase());
    const extra = keys.filter((key) => key !== 'true' && key !== 'false');
    if (extra.length > 0) {
      throw new LayaValidationError(
        `Question "${name}": a noul question takes "criteria" keyed only "true"/"false" ` +
          `(either or both, and omitted is fine), got ${JSON.stringify(extra)}. Those keys are ` +
          `the option texts the model reads; any other key is rejected rather than silently dropped.`,
      );
    }
  }
}
