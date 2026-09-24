import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Laya, LayaValidationError } from '../src/index.js';
import { startMockServer, type MockServer } from './mock-server.js';

let server: MockServer;
beforeAll(async () => {
  server = await startMockServer();
});
afterAll(async () => {
  await server.close();
});

const client = (threshold = 0.3): Laya =>
  new Laya({ endpoint: server.url, retries: 0, threshold });

describe('router', () => {
  it('executes the handler for the selected route', async () => {
    const search = vi.fn(async () => 'search result');
    const code = vi.fn(async () => 'code result');

    const router = client().createRouter({ routes: { search, code } });
    const result = await router.run('please search the web for cats');

    expect(result.route).toBe('search');
    expect(result.handled).toBe(true);
    expect(result.result).toBe('search result');
    expect(search).toHaveBeenCalledOnce();
    expect(code).not.toHaveBeenCalled();
  });

  it('gives the handler the input and the routing context', async () => {
    let seenInput: unknown;
    let seenContext: unknown;
    const router = client().createRouter({
      routes: {
        search: async (input, context) => {
          seenInput = input;
          seenContext = context;
          return 'ok';
        },
        code: async () => 'no',
      },
    });

    await router.run('search for something');
    expect(seenInput).toBe('search for something');
    expect(seenContext).toMatchObject({ route: 'search' });
    expect(typeof (seenContext as { confidence: number }).confidence).toBe('number');
  });

  it('returns route + confidence + result + metadata', async () => {
    const router = client().createRouter({ routes: { search: async () => 1, code: async () => 2 } });
    const result = await router.run('search please');

    expect(result).toHaveProperty('route');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('result');
    expect(result).toHaveProperty('probabilities');
    expect(result.meta.requestId).toBeTruthy();
    expect(typeof result.meta.latencyMs).toBe('number');
    expect(result.decision.label).toBe(result.suggested);
  });

  it('runs no handler when confidence is below threshold', async () => {
    const search = vi.fn(async () => 'x');
    const router = client(0.999).createRouter({ routes: { search, code: async () => 'y' } });
    const result = await router.run('search please');

    expect(result.handled).toBe(false);
    expect(result.route).toBeNull();
    expect(result.result).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
    // The suggestion is still reported, so callers can log or override.
    expect(result.suggested).toBeTruthy();
  });

  it('calls the router fallback instead of a handler when unsure', async () => {
    const fallback =
      vi.fn<(context: { threshold: number }) => Promise<string>>(async () => 'escalated to a big model');
    const router = client(0.999).createRouter({
      routes: { search: async () => 'x', code: async () => 'y' },
      fallback,
    });
    const result = await router.run('ambiguous request');

    expect(result.fallbackUsed).toBe(true);
    expect(result.handled).toBe(false);
    expect(result.result).toBe('escalated to a big model');
    expect(fallback).toHaveBeenCalledOnce();
    expect(fallback.mock.calls[0]![0]).toMatchObject({ threshold: 0.999 });
  });

  it('sends route descriptions as choice criteria when provided', async () => {
    const router = client().createRouter({
      routes: { search: async () => 1, code: async () => 2 },
      descriptions: { search: 'web lookups', code: 'writing or fixing code' },
    });
    await router.run('hello');

    const sent = server.requests.at(-1)!;
    expect(sent.questions.label!.criteria).toEqual({
      search: 'web lookups',
      code: 'writing or fixing code',
    });
  });

  it('sends a bare label list when no descriptions are given', async () => {
    const router = client().createRouter({ routes: { search: async () => 1, code: async () => 2 } });
    await router.run('hello');
    expect(server.requests.at(-1)!.questions.label!.criteria).toEqual(['search', 'code']);
  });

  it('exposes the registered route names', () => {
    const router = client().createRouter({ routes: { a: async () => 1, b: async () => 2 } });
    expect(router.routes).toEqual(['a', 'b']);
  });

  it('rejects an empty route table', () => {
    expect(() => client().createRouter({ routes: {} })).toThrow(LayaValidationError);
  });

  it('rejects a non-function handler', () => {
    expect(() =>
      client().createRouter({
        routes: { bad: 'rm -rf /' as unknown as () => unknown },
      }),
    ).toThrow(/not a function/);
  });

  it('per-call threshold overrides the router threshold', async () => {
    const router = client(0.0).createRouter({
      routes: { search: async () => 'ran', code: async () => 'no' },
      threshold: 0,
    });
    const strict = await router.run('search', { threshold: 0.999 });
    expect(strict.handled).toBe(false);
    const loose = await router.run('search', { threshold: 0 });
    expect(loose.handled).toBe(true);
  });
});

describe('router security', () => {
  it('cannot be made to execute an unregistered name from model output', async () => {
    // A server that answers with a label outside the schema — the shape of an
    // attack where model output is trusted as a function name.
    const rogue = await startMockServer({
      respondWith: {
        model: 'rogue',
        answers: {
          label: {
            type: 'choice',
            choice: 'constructor',
            probabilities: { constructor: 1 },
            confidence: 1,
            answer_confidence: 1,
            action: { act_probability: 1 },
          },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    const search = vi.fn(async () => 'x');
    const router = new Laya({ endpoint: rogue.url, retries: 0, threshold: 0 }).createRouter({
      routes: { search },
    });
    const result = await router.run('anything');

    expect(result.handled).toBe(false);
    expect(result.route).toBeNull();
    expect(search).not.toHaveBeenCalled();
    await rogue.close();
  });

  it('does not reach prototype members via a __proto__ label', async () => {
    const rogue = await startMockServer({
      respondWith: {
        model: 'rogue',
        answers: {
          label: {
            type: 'choice',
            choice: '__proto__',
            probabilities: { __proto__: 1 },
            confidence: 1,
            answer_confidence: 1,
            action: { act_probability: 1 },
          },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    const router = new Laya({ endpoint: rogue.url, retries: 0, threshold: 0 }).createRouter({
      routes: { search: async () => 'x' },
    });
    const result = await router.run('anything');
    expect(result.handled).toBe(false);
    await rogue.close();
  });
});
