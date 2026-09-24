import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  HttpTransport,
  Laya,
  LayaAuthError,
  LayaConnectionError,
  LayaInferenceError,
  LayaTimeoutError,
  LayaValidationError,
  isLayaError,
} from '../src/index.js';
import { startMockServer, type MockServer } from './mock-server.js';

let server: MockServer;
beforeAll(async () => {
  server = await startMockServer();
});
afterAll(async () => {
  await server.close();
});

const classify = (client: Laya): Promise<unknown> =>
  client.classify({ input: 'x', labels: ['a', 'b'] });

describe('errors', () => {
  it('raises LayaConnectionError with an actionable message when nothing is listening', async () => {
    // Port 1 is reserved and never has a Laya server on it.
    const client = new Laya({ endpoint: 'http://127.0.0.1:1', retries: 0, timeout: 2000 });
    const error = await classify(client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LayaConnectionError);
    expect(isLayaError(error)).toBe(true);
    const message = (error as Error).message;
    expect(message).toContain('Unable to connect to Laya at http://127.0.0.1:1');
    expect(message).toContain('laya-serve');
    expect(message).toContain('LAYA_ENDPOINT');
  });

  it('raises LayaTimeoutError naming the timeout', async () => {
    const slow = await startMockServer({ delayMs: 300 });
    const client = new Laya({ endpoint: slow.url, timeout: 40, retries: 0 });
    const error = await classify(client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LayaTimeoutError);
    expect((error as LayaTimeoutError).timeoutMs).toBe(40);
    expect((error as Error).message).toContain('timed out after 40ms');
    await slow.close();
  });

  it('raises LayaAuthError on 401 and explains LAYA_API_KEY', async () => {
    const secured = await startMockServer({ apiKey: 'correct-key' });
    const client = new Laya({ endpoint: secured.url, apiKey: 'wrong-key', retries: 0 });
    const error = await classify(client).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LayaAuthError);
    expect((error as Error).message).toContain('LAYA_API_KEY');
    await secured.close();
  });

  it('succeeds when the bearer token matches', async () => {
    const secured = await startMockServer({ apiKey: 'correct-key' });
    const client = new Laya({ endpoint: secured.url, apiKey: 'correct-key', retries: 0 });
    await expect(classify(client)).resolves.toBeDefined();
    await secured.close();
  });

  it('maps 422 to LayaValidationError', async () => {
    const bad = await startMockServer({ failWith: 422 });
    const client = new Laya({ endpoint: bad.url, retries: 0 });
    const error = await classify(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LayaValidationError);
    expect((error as LayaValidationError).status).toBe(422);
    await bad.close();
  });

  it('maps 413 to LayaValidationError', async () => {
    const bad = await startMockServer({ failWith: 413 });
    const client = new Laya({ endpoint: bad.url, retries: 0 });
    await expect(classify(client)).rejects.toBeInstanceOf(LayaValidationError);
    await bad.close();
  });

  it('maps 500 to LayaInferenceError', async () => {
    const bad = await startMockServer({ failWith: 500 });
    const client = new Laya({ endpoint: bad.url, retries: 0 });
    await expect(classify(client)).rejects.toBeInstanceOf(LayaInferenceError);
    await bad.close();
  });

  it('explains a 404 as a wrong base URL rather than a generic failure', async () => {
    const client = new Laya({ endpoint: `${server.url}/v1/systemone`, retries: 0 });
    const error = await classify(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LayaConnectionError);
    expect((error as Error).message).toContain('without a path');
  });

  it('carries the endpoint on the error for logging', async () => {
    const bad = await startMockServer({ failWith: 500 });
    const client = new Laya({ endpoint: bad.url, retries: 0 });
    const error = (await classify(client).catch((e: unknown) => e)) as LayaInferenceError;
    expect(error.endpoint).toBe(bad.url);
    await bad.close();
  });
});

describe('retries', () => {
  it('retries a 503 and then succeeds', async () => {
    const flaky = await startMockServer({ failTimes: 2 });
    const client = new Laya({ endpoint: flaky.url, retries: 3 });
    await expect(classify(client)).resolves.toBeDefined();
    expect(flaky.requestCount()).toBe(3);
    await flaky.close();
  });

  it('never retries a validation error', async () => {
    const bad = await startMockServer({ failWith: 422 });
    const client = new Laya({ endpoint: bad.url, retries: 3 });
    await expect(classify(client)).rejects.toBeInstanceOf(LayaValidationError);
    expect(bad.requestCount()).toBe(1);
    await bad.close();
  });

  it('gives up after the configured number of retries', async () => {
    const bad = await startMockServer({ failWith: 503 });
    const client = new Laya({ endpoint: bad.url, retries: 2 });
    await expect(classify(client)).rejects.toThrow();
    expect(bad.requestCount()).toBe(3);
    await bad.close();
  });
});

describe('HttpTransport', () => {
  it('normalizes a trailing slash in the endpoint', () => {
    const transport = new HttpTransport({ endpoint: 'http://x:8000/', timeout: 1000, retries: 0 });
    expect(transport.endpoint).toBe('http://x:8000');
  });

  it('sends a bearer header only when an api key is set', async () => {
    const seen: Array<Record<string, string>> = [];
    const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await new HttpTransport({ endpoint: 'http://x', timeout: 1000, retries: 0, fetch: fakeFetch })
      .request({ path: '/health', method: 'GET' });
    expect(seen[0]).not.toHaveProperty('authorization');

    await new HttpTransport({
      endpoint: 'http://x',
      timeout: 1000,
      retries: 0,
      apiKey: 'k',
      fetch: fakeFetch,
    }).request({ path: '/health', method: 'GET' });
    expect(seen[1]?.authorization).toBe('Bearer k');
  });

  it('sends custom headers', async () => {
    let seen: Record<string, string> = {};
    const fakeFetch: typeof globalThis.fetch = async (_url, init) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await new HttpTransport({
      endpoint: 'http://x',
      timeout: 1000,
      retries: 0,
      headers: { 'x-trace': 'abc' },
      fetch: fakeFetch,
    }).request({ path: '/health', method: 'GET' });
    expect(seen['x-trace']).toBe('abc');
  });

  it('turns a non-JSON body into a clear connection error', async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response('<html>proxy error</html>', { status: 200 });
    const transport = new HttpTransport({
      endpoint: 'http://x',
      timeout: 1000,
      retries: 0,
      fetch: fakeFetch,
    });
    await expect(transport.request({ path: '/health', method: 'GET' })).rejects.toThrow(
      /non-JSON response/,
    );
  });

  it('surfaces the server detail field in the error message', async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "question 'x': no 'instructions'" }), { status: 422 });
    const transport = new HttpTransport({
      endpoint: 'http://x',
      timeout: 1000,
      retries: 0,
      fetch: fakeFetch,
    });
    await expect(transport.request({ path: '/v1/systemone', method: 'POST' })).rejects.toThrow(
      /no 'instructions'/,
    );
  });

  it('honours an external abort signal', async () => {
    const slow = await startMockServer({ delayMs: 500 });
    const controller = new AbortController();
    const client = new Laya({ endpoint: slow.url, retries: 0, timeout: 5000 });
    const promise = client.classify({ input: 'x', labels: ['a', 'b'], signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow();
    await slow.close();
  });
});

describe('custom transport', () => {
  it('replaces the network entirely', async () => {
    const client = new Laya({
      endpoint: 'http://unused',
      transport: {
        endpoint: 'http://unused',
        request: async <T,>(): Promise<T> =>
          ({
            model: 'fake',
            answers: {
              label: {
                type: 'choice',
                choice: 'billing',
                probabilities: { billing: 0.9, other: 0.1 },
                confidence: 0.7,
                answer_confidence: 0.9,
                action: { act_probability: 0.5 },
              },
            },
            usage: { input_tokens: 1, output_tokens: 0 },
          }) as T,
      },
    });
    const result = await client.classify({ input: 'anything', labels: ['billing', 'other'] });
    expect(result.label).toBe('billing');
    expect(result.confidence).toBe(0.9);
    expect(result.meta.model).toBe('fake');
  });
});
