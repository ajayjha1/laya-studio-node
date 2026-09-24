import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Laya, presets, PRESET_NAMES, triage, guard, email, moderation, router } from '../src/index.js';
import { startMockServer, type MockServer } from './mock-server.js';

let server: MockServer;
const laya = (): Laya => new Laya({ endpoint: server.url, retries: 0, threshold: 0.1 });

beforeAll(async () => {
  server = await startMockServer();
});
afterAll(async () => {
  await server.close();
});

describe('presets match Laya', () => {
  it('exposes exactly the five Laya presets', () => {
    expect([...PRESET_NAMES].sort()).toEqual(['email', 'guard', 'moderation', 'router', 'triage']);
    expect(Object.keys(presets).sort()).toEqual([...PRESET_NAMES].sort());
  });

  it('triage has Laya’s question names and types', () => {
    const t = triage();
    expect(Object.keys(t)).toEqual([
      'intent',
      'is_urgent',
      'frustration',
      'refund_requested',
      'churn_risk',
    ]);
    expect(t.intent!.kind).toBe('choice');
    expect(t.is_urgent!.kind).toBe('noul');
    expect(t.frustration!.kind).toBe('score');
  });

  it('triage intent carries Laya’s six labels and descriptions', () => {
    const intent = triage().intent as unknown as { labels: Record<string, string> };
    expect(Object.keys(intent.labels)).toEqual([
      'refund',
      'technical_help',
      'billing_question',
      'information',
      'cancellation',
      'other',
    ]);
    expect(intent.labels.refund).toBe('money returned or a duplicate charge reversed');
  });

  it('triage frustration has Laya’s four ordered levels', () => {
    const frustration = triage().frustration as unknown as { levels: string[] };
    expect(frustration.levels).toEqual([
      'calm and neutral',
      'concerned but civil',
      'clearly annoyed',
      'very angry or using strong language',
    ]);
  });

  it('email accepts custom categories but keeps the rest of the preset', () => {
    const custom = email({ alpha: 'first', beta: 'second' });
    expect((custom.category as unknown as { labels: Record<string, string> }).labels).toEqual({
      alpha: 'first',
      beta: 'second',
    });
    // The non-category questions are unchanged.
    expect(Object.keys(custom)).toEqual([
      'category',
      'is_spam',
      'is_phishing',
      'urgency',
      'needs_reply',
    ]);
  });

  it('email is_phishing keeps Laya’s true/false criteria wording', () => {
    const phishing = email().is_phishing as unknown as { whenTrue: string; whenFalse: string };
    expect(phishing.whenTrue).toBe('phishing, scam, or fraud');
    expect(phishing.whenFalse).toBe('a legitimate email');
  });

  it('guard, moderation and router expose Laya’s question names', () => {
    expect(Object.keys(guard())).toEqual([
      'jailbreak',
      'prompt_injection',
      'sensitive_data',
      'harm_severity',
      'topic',
    ]);
    expect(Object.keys(moderation())).toEqual([
      'toxic',
      'harassment',
      'threat',
      'spam',
      'severity',
    ]);
    expect(Object.keys(router())).toEqual([
      'difficulty',
      'domain',
      'needs_tools',
      'is_sensitive',
    ]);
  });

  it('returns a fresh object each call, so callers can mutate safely', () => {
    const a = triage();
    const b = triage();
    expect(a).not.toBe(b);
    delete a.intent;
    expect(b.intent).toBeDefined();
  });
});

describe('presets over the wire', () => {
  it('runs a whole preset in ONE request', async () => {
    const before = server.requestCount();
    const result = await laya().decide({ input: { message: 'I want a refund' }, decisions: triage() });

    expect(server.requestCount()).toBe(before + 1);
    expect(Object.keys(result)).toHaveLength(5);
    expect(typeof (result.intent as { label: string }).label).toBe('string');
    expect(typeof (result.frustration as { score: number }).score).toBe('number');
    expect(typeof (result.churn_risk as { value: boolean }).value).toBe('boolean');
  });

  it('sends the exact question shapes the server accepts', async () => {
    await laya().decide({ input: { prompt: 'hello' }, decisions: guard() });
    const sent = server.requests.at(-1)!;

    expect(sent.questions.jailbreak!.type).toBe('noul');
    expect(sent.questions.harm_severity!.type).toBe('score');
    expect(sent.questions.topic!.type).toBe('choice');
    // Every question carries instructions, which the server requires.
    for (const question of Object.values(sent.questions)) {
      expect(typeof question.instructions).toBe('string');
      expect(question.instructions.length).toBeGreaterThan(0);
    }
  });

  it('every preset is under the 64-question server limit', () => {
    for (const name of PRESET_NAMES) {
      expect(Object.keys(presets[name]()).length).toBeLessThanOrEqual(64);
    }
  });

  it('every preset round-trips through the server', async () => {
    for (const name of PRESET_NAMES) {
      const result = await laya().decide({ input: 'some text', decisions: presets[name]() });
      expect(Object.keys(result)).toEqual(Object.keys(presets[name]()));
    }
  });
});
