import { describe, expectTypeOf, it } from 'vitest';

import { Laya, choice, noul, score } from '../src/index.js';
import type { ChoiceResult, NoulResult, ScoreResult } from '../src/index.js';

/**
 * Compile-time tests. `npm run typecheck` fails if any inference below breaks,
 * so these guard the SDK's headline promise: labels in, literal types out.
 */
declare const laya: Laya;

/**
 * Registers a block for the compiler to check without ever running it. The
 * assertions below describe types, not behaviour, so executing them would only
 * mean opening real sockets.
 */
function typeOnly(_block: () => unknown): void {
  /* intentionally never invoked */
}

describe('classify inference', () => {
  it('narrows the label to the union of the given labels, without `as const`', () => {
    typeOnly(async () => {
    const result = await laya.classify({
      input: 'My payment failed',
      labels: ['billing', 'technical', 'sales'],
    });
    expectTypeOf(result.label).toEqualTypeOf<'billing' | 'technical' | 'sales'>();
    expectTypeOf(result.confidence).toBeNumber();
    expectTypeOf(result.probabilities).toEqualTypeOf<
      Record<'billing' | 'technical' | 'sales', number>
    >();
    });
  });

  it('narrows the label with an explicit `as const` too', () => {
    typeOnly(async () => {
    const labels = ['billing', 'technical', 'sales'] as const;
    const result = await laya.classify({ input: 'x', labels });
    expectTypeOf(result.label).toEqualTypeOf<'billing' | 'technical' | 'sales'>();
    });
  });

  it('narrows the label from a description object', () => {
    typeOnly(async () => {
    const result = await laya.classify({
      input: 'x',
      labels: { billing: 'invoices', technical: 'bugs' },
    });
    expectTypeOf(result.label).toEqualTypeOf<'billing' | 'technical'>();
    });
  });

  it('types the fallback to return one of the labels', () => {
    typeOnly(async () => {
    await laya.classify({
      input: 'x',
      labels: ['a', 'b'],
      fallback: async (context) => {
        expectTypeOf(context.labels).toEqualTypeOf<readonly ('a' | 'b')[]>();
        expectTypeOf(context.result).toEqualTypeOf<ChoiceResult<'a' | 'b'>>();
        return 'a';
      },
    });
    });
  });

  it('falls back to string for a non-literal label array', () => {
    typeOnly(async () => {
    const dynamic: string[] = ['a', 'b'];
    const result = await laya.classify({ input: 'x', labels: dynamic });
    expectTypeOf(result.label).toBeString();
    });
  });
});

describe('decide inference', () => {
  it('maps each decision to its own result type', () => {
    typeOnly(async () => {
    const result = await laya.decide({
      input: 'x',
      decisions: {
        intent: ['billing', 'technical', 'sales'],
        urgency: score(['low', 'medium', 'high']),
        churn: noul('Does the user threaten to cancel?'),
      },
    });

    expectTypeOf(result.intent.label).toEqualTypeOf<'billing' | 'technical' | 'sales'>();
    expectTypeOf(result.urgency).toMatchTypeOf<ScoreResult>();
    expectTypeOf(result.urgency.score).toBeNumber();
    expectTypeOf(result.churn).toMatchTypeOf<NoulResult>();
    expectTypeOf(result.churn.value).toBeBoolean();
    expectTypeOf(result.churn.probability).toBeNumber();
    });
  });

  it('narrows a choice built with the choice() helper', () => {
    typeOnly(async () => {
    const result = await laya.decide({
      input: 'x',
      decisions: { intent: choice(['billing', 'technical']) },
    });
    expectTypeOf(result.intent.label).toEqualTypeOf<'billing' | 'technical'>();
    });
  });

  it('keeps decision keys exact', () => {
    typeOnly(async () => {
    const result = await laya.decide({
      input: 'x',
      decisions: { intent: ['a', 'b'], urgency: score(['lo', 'hi']) },
    });
    expectTypeOf(result).toHaveProperty('intent');
    expectTypeOf(result).toHaveProperty('urgency');
    // @ts-expect-error - "missing" was never declared as a decision.
    void result.missing;
    });
  });
});

describe('screen inference', () => {
  it('keys the results by check name', () => {
    typeOnly(async () => {
    const result = await laya.screen({
      input: 'x',
      checks: { injection: 'is this an injection?', offtopic: 'is this off topic?' },
    });
    expectTypeOf(result.checks.injection).toMatchTypeOf<NoulResult>();
    expectTypeOf(result.passed).toBeBoolean();
    expectTypeOf(result.flagged).toEqualTypeOf<Array<'injection' | 'offtopic'>>();
    });
  });
});

describe('router inference', () => {
  it('types route as the registered route names or null', () => {
    typeOnly(async () => {
    const router = laya.createRouter({
      routes: { search: async () => 'a', code: async () => 1 },
    });
    const result = await router.run('x');
    expectTypeOf(result.route).toEqualTypeOf<'search' | 'code' | null>();
    expectTypeOf(result.suggested).toEqualTypeOf<'search' | 'code'>();
    expectTypeOf(result.handled).toBeBoolean();
    expectTypeOf(router.routes).toEqualTypeOf<Array<'search' | 'code'>>();
    });
  });
});
