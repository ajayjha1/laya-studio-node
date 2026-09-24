import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Laya, LayaValidationError, planFromJsonSchema, questionsFromJsonSchema } from '../src/index.js';
import { startMockServer, type MockServer } from './mock-server.js';

let server: MockServer;
const laya = (): Laya => new Laya({ endpoint: server.url, retries: 0, threshold: 0.1 });

beforeAll(async () => {
  server = await startMockServer();
});
afterAll(async () => {
  await server.close();
});

describe('schema -> questions mapping', () => {
  it('maps enum to choice', () => {
    const [field] = planFromJsonSchema({
      properties: { dept: { enum: ['billing', 'technical'] } },
    });
    expect(field!.kind).toBe('choice');
    expect(field!.question).toMatchObject({ type: 'choice', criteria: ['billing', 'technical'] });
  });

  it('maps boolean to noul', () => {
    const [field] = planFromJsonSchema({ properties: { isSpam: { type: 'boolean' } } });
    expect(field!.kind).toBe('noul');
    expect(field!.question.type).toBe('noul');
  });

  it('maps a bounded integer to a score with one level per value', () => {
    const [field] = planFromJsonSchema({
      properties: { urgency: { type: 'integer', minimum: 0, maximum: 3 } },
    });
    expect(field!.kind).toBe('score');
    expect(field!.question).toMatchObject({ type: 'score', criteria: ['0', '1', '2', '3'] });
    expect(field!.minimum).toBe(0);
  });

  it('maps const to a single-option choice', () => {
    const [field] = planFromJsonSchema({ properties: { kind: { const: 'ticket' } } });
    expect(field!.kind).toBe('choice');
    expect(field!.question).toMatchObject({ criteria: ['ticket'] });
  });

  it('treats an all-boolean enum as noul, not a two-way choice', () => {
    const [field] = planFromJsonSchema({ properties: { flag: { enum: [true, false] } } });
    expect(field!.kind).toBe('noul');
  });

  it('unwraps a nullable type such as ["string","null"]', () => {
    // The non-null member decides; a bare string still cannot be a question.
    expect(() =>
      planFromJsonSchema({ properties: { name: { type: ['string', 'null'] } } }),
    ).toThrow(/free string cannot be a fixed option set/);
  });

  it('uses description as the instructions when given', () => {
    const [field] = planFromJsonSchema({
      properties: { dept: { enum: ['a', 'b'], description: 'Which team owns this?' } },
    });
    expect(field!.question.instructions).toBe('Which team owns this?');
  });

  it('falls back to a generated question when no description is given', () => {
    const [field] = planFromJsonSchema({ properties: { dept: { enum: ['a', 'b'] } } });
    expect(field!.question.instructions).toBe('What is `dept`?');
  });

  it('compiles a whole schema to questions', () => {
    const questions = questionsFromJsonSchema({
      properties: {
        dept: { enum: ['billing', 'technical'] },
        urgent: { type: 'boolean' },
        score: { type: 'integer', minimum: 1, maximum: 5 },
      },
    });
    expect(Object.keys(questions)).toEqual(['dept', 'urgent', 'score']);
    expect(questions.dept!.type).toBe('choice');
    expect(questions.urgent!.type).toBe('noul');
    expect(questions.score!.type).toBe('score');
  });
});

describe('schema refusals mirror Laya', () => {
  const rejects = (schema: Parameters<typeof planFromJsonSchema>[0], pattern: RegExp): void => {
    expect(() => planFromJsonSchema(schema)).toThrow(LayaValidationError);
    expect(() => planFromJsonSchema(schema)).toThrow(pattern);
  };

  it('rejects a free string', () => {
    rejects({ properties: { name: { type: 'string' } } }, /free string cannot be a fixed option set/);
  });

  it('rejects arrays', () => {
    rejects({ properties: { tags: { type: 'array' } } }, /arrays are not supported/);
  });

  it('rejects nested objects', () => {
    rejects({ properties: { meta: { type: 'object' } } }, /nested objects are not supported/);
  });

  it('rejects $ref', () => {
    rejects({ properties: { other: { $ref: '#/definitions/x' } } }, /\$ref\/recursion is not supported/);
  });

  it('rejects a numeric field without integer bounds', () => {
    rejects(
      { properties: { n: { type: 'integer' } } },
      /needs integer 'minimum' and 'maximum'/,
    );
  });

  it('rejects maximum below minimum', () => {
    rejects(
      { properties: { n: { type: 'integer', minimum: 5, maximum: 1 } } },
      /'maximum' 1 is below 'minimum' 5/,
    );
  });

  it('rejects a score range wider than Laya allows', () => {
    rejects(
      { properties: { n: { type: 'integer', minimum: 0, maximum: 50 } } },
      /exceeds MAX_SCORE_LEVELS=10/,
    );
  });

  it('rejects an empty enum', () => {
    rejects({ properties: { x: { enum: [] } } }, /'enum' must not be empty/);
  });

  it('rejects too many options', () => {
    rejects(
      { properties: { x: { enum: Array.from({ length: 300 }, (_, i) => `o${i}`) } } },
      /exceeds MAX_OPTIONS=255/,
    );
  });

  it('rejects a schema with no properties', () => {
    rejects({}, /must have a 'properties' object/);
    rejects({ properties: {} }, /must contain at least one property/);
  });
});

describe('decideFromSchema', () => {
  it('answers a whole schema in ONE request and decodes each type', async () => {
    const before = server.requestCount();
    const result = await laya().decideFromSchema({
      input: 'we were billed twice for March',
      schema: {
        type: 'object',
        properties: {
          department: { enum: ['billing', 'technical'], description: 'Which team?' },
          urgency: { type: 'integer', minimum: 0, maximum: 3 },
          isSpam: { type: 'boolean' },
        },
      },
    });

    expect(server.requestCount()).toBe(before + 1);
    expect(typeof result.values.department).toBe('string');
    expect(typeof result.values.urgency).toBe('number');
    expect(typeof result.values.isSpam).toBe('boolean');
    expect(Number.isInteger(result.values.urgency)).toBe(true);
  });

  it('decodes a choice back to its original non-string enum value', async () => {
    const result = await laya().decideFromSchema({
      input: 'x',
      schema: { properties: { level: { enum: [10, 20, 30] } } },
    });
    // The label is a string on the wire; the decoded value is the schema's number.
    expect(typeof result.values.level).toBe('number');
    expect([10, 20, 30]).toContain(result.values.level);
  });

  it('shifts a score by the schema minimum', async () => {
    const result = await laya().decideFromSchema({
      input: 'x',
      schema: { properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } } },
    });
    const rating = result.values.rating as number;
    expect(rating).toBeGreaterThanOrEqual(1);
    expect(rating).toBeLessThanOrEqual(5);
  });

  it('reports per-field confidence and flags low-confidence properties', async () => {
    const strict = new Laya({ endpoint: server.url, retries: 0, threshold: 0.999 });
    const result = await strict.decideFromSchema({
      input: 'ambiguous',
      schema: { properties: { dept: { enum: ['a', 'b', 'c'] } } },
    });

    expect(typeof result.fields.dept!.confidence).toBe('number');
    expect(result.fields.dept!.kind).toBe('choice');
    expect(result.fields.dept!.isConfident(0)).toBe(true);
    expect(result.lowConfidence).toContain('dept');
  });

  it('keeps the raw answer for every field', async () => {
    const result = await laya().decideFromSchema({
      input: 'x',
      schema: { properties: { ok: { type: 'boolean' } } },
    });
    expect(result.fields.ok!.raw).toHaveProperty('answer_confidence');
    expect(result.fields.ok!.raw.type).toBe('noul');
  });

  it('rejects an unsupported schema before any request', async () => {
    const before = server.requestCount();
    await expect(
      laya().decideFromSchema({ input: 'x', schema: { properties: { n: { type: 'string' } } } }),
    ).rejects.toThrow(LayaValidationError);
    expect(server.requestCount()).toBe(before);
  });
});
