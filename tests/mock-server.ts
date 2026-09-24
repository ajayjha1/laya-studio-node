import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { LayaAnswer, LayaQuestion, SystemOneRequest, SystemOneResponse } from '../src/wire.js';

/**
 * A fake `laya-serve`.
 *
 * It reproduces the real server's contract — routes, status codes, limits,
 * bearer check and answer shapes from laya/serve.py and laya/agent.py — so the
 * integration tests exercise the same paths a real deployment would. The
 * "model" is deterministic keyword scoring, because these tests are about the
 * SDK, not about Laya's accuracy.
 */

export interface MockOptions {
  apiKey?: string;
  /** Force every /v1/systemone call to fail with this status. */
  failWith?: number;
  /** Milliseconds to stall before responding. */
  delayMs?: number;
  /** Succeed only after this many attempts (to test retries). */
  failTimes?: number;
  /** Return this body verbatim instead of a computed one. */
  respondWith?: unknown;
}

export interface MockServer {
  url: string;
  close: () => Promise<void>;
  /** Every /v1/systemone body received, in order. */
  requests: SystemOneRequest[];
  options: MockOptions;
  requestCount: () => number;
}

const MAX_QUESTIONS = 64;
const MAX_STATE_CHARS = 50_000;

/** Deterministic pseudo-probabilities: keyword overlap between state and option. */
function scoreOptions(state: string, options: string[]): number[] {
  const haystack = state.toLowerCase();
  const raw = options.map((option) => {
    const tokens = option.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const hits = tokens.filter((t) => haystack.includes(t)).length;
    return 1 + hits * 12;
  });
  const total = raw.reduce((sum, v) => sum + v, 0);
  return raw.map((v) => Number((v / total).toFixed(4)));
}

function entropyConfidence(probabilities: number[]): number {
  const k = probabilities.length;
  if (k <= 1) return 1;
  const entropy = -probabilities.reduce((sum, p) => (p > 0 ? sum + p * Math.log(p) : sum), 0);
  return Number((1 - entropy / Math.log(k)).toFixed(4));
}

function answerQuestion(state: string, question: LayaQuestion): LayaAnswer {
  const action = { act_probability: 0.9 };

  if (question.type === 'choice') {
    const labels = Array.isArray(question.criteria)
      ? question.criteria
      : Object.keys(question.criteria);
    const probabilities = scoreOptions(state, labels);
    let best = 0;
    probabilities.forEach((p, i) => {
      if (p > (probabilities[best] as number)) best = i;
    });
    return {
      type: 'choice',
      choice: labels[best] as string,
      probabilities: Object.fromEntries(labels.map((l, i) => [l, probabilities[i] as number])),
      confidence: entropyConfidence(probabilities),
      answer_confidence: probabilities[best] as number,
      action,
    };
  }

  if (question.type === 'score') {
    const levels = question.criteria;
    const probabilities = scoreOptions(state, levels);
    const expected = probabilities.reduce((sum, p, i) => sum + p * i, 0);
    let best = 0;
    probabilities.forEach((p, i) => {
      if (p > (probabilities[best] as number)) best = i;
    });
    return {
      type: 'score',
      score: Number(expected.toFixed(4)),
      legend: Object.fromEntries(levels.map((l, i) => [String(i), l])),
      probabilities: Object.fromEntries(probabilities.map((p, i) => [String(i), p])),
      confidence: entropyConfidence(probabilities),
      answer_confidence: probabilities[best] as number,
      action,
    };
  }

  // noul: P(yes) from overlap with the question's own wording.
  const [, yes] = scoreOptions(state, ['__no__', question.instructions]);
  const probability = Number((yes as number).toFixed(4));
  return {
    type: 'noul',
    noul: probability,
    confidence: Number(Math.max(probability, 1 - probability).toFixed(4)),
    answer_confidence: Number(Math.max(probability, 1 - probability).toFixed(4)),
    action,
  };
}

export async function startMockServer(options: MockOptions = {}): Promise<MockServer> {
  const requests: SystemOneRequest[] = [];
  let attempts = 0;

  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    };

    if (req.method === 'GET' && req.url === '/health') {
      send(200, { status: 'ok', loaded: ['english', 'multilingual'], device: 'cpu' });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/v1/systemone') {
      send(404, { detail: 'Not Found' });
      return;
    }

    if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) {
      send(401, { detail: 'invalid or missing bearer token' });
      return;
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      attempts++;

      const respond = (): void => {
        if (options.failTimes !== undefined && attempts <= options.failTimes) {
          send(503, { detail: 'temporarily unavailable' });
          return;
        }
        if (options.failWith) {
          send(options.failWith, { detail: 'forced failure' });
          return;
        }

        let body: SystemOneRequest;
        try {
          body = JSON.parse(raw) as SystemOneRequest;
        } catch {
          send(400, { detail: 'request body must be valid JSON' });
          return;
        }
        if (typeof body !== 'object' || body === null || !('questions' in body)) {
          send(400, { detail: "request body must be an object with a 'questions' field" });
          return;
        }
        requests.push(body);

        if (options.respondWith !== undefined) {
          send(200, options.respondWith);
          return;
        }

        const questions = body.questions;
        if (typeof questions !== 'object' || questions === null) {
          send(400, { detail: "'questions' must be an object" });
          return;
        }
        const names = Object.keys(questions);
        if (names.length > MAX_QUESTIONS) {
          send(413, { detail: `too many questions (${names.length} > ${MAX_QUESTIONS})` });
          return;
        }

        const state = typeof body.state === 'string' ? body.state : JSON.stringify(body.state ?? '');
        if (state.length > MAX_STATE_CHARS) {
          send(413, { detail: `state too large (${state.length} > ${MAX_STATE_CHARS} chars)` });
          return;
        }

        const answers: Record<string, LayaAnswer> = {};
        for (const name of names) {
          const question = questions[name] as LayaQuestion;
          if (!question || typeof question.instructions !== 'string') {
            send(422, { detail: `question '${name}': no 'instructions'` });
            return;
          }
          answers[name] = answerQuestion(state, question);
        }

        const response: SystemOneResponse = {
          model: body.model ?? 'laya-rl-agent',
          answers,
          usage: { input_tokens: Math.ceil(state.length / 4), output_tokens: 0 },
          routing: { model: body.model ?? 'english', reason: 'mock' },
        };
        send(200, response);
      };

      if (options.delayMs) setTimeout(respond, options.delayMs);
      else respond();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    options,
    requestCount: () => attempts,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
