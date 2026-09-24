import { describe, expect, it } from 'vitest';

import { summarize, type EvalPrediction } from '../src/index.js';
import { parseDataset, percentile } from '../src/eval/metrics.js';

const prediction = (
  expected: string,
  predicted: string,
  confidence = 0.9,
  latencyMs = 10,
): EvalPrediction => ({ expected, predicted, confidence, latencyMs });

describe('summarize', () => {
  it('computes accuracy from the predictions given', () => {
    const report = summarize(
      [
        prediction('billing', 'billing'),
        prediction('billing', 'technical'),
        prediction('technical', 'technical'),
        prediction('technical', 'technical'),
      ],
      1000,
    );
    expect(report.total).toBe(4);
    expect(report.correct).toBe(3);
    expect(report.accuracy).toBe(0.75);
  });

  it('computes precision, recall and F1 per label', () => {
    // billing: 1 TP, 0 FP, 1 FN -> P=1, R=0.5, F1=0.667
    // technical: 2 TP, 1 FP, 0 FN -> P=0.667, R=1, F1=0.8
    const report = summarize(
      [
        prediction('billing', 'billing'),
        prediction('billing', 'technical'),
        prediction('technical', 'technical'),
        prediction('technical', 'technical'),
      ],
      1000,
    );
    const billing = report.perLabel.find((m) => m.label === 'billing')!;
    expect(billing.precision).toBe(1);
    expect(billing.recall).toBe(0.5);
    expect(billing.f1).toBeCloseTo(0.6667, 3);

    const technical = report.perLabel.find((m) => m.label === 'technical')!;
    expect(technical.precision).toBeCloseTo(0.6667, 3);
    expect(technical.recall).toBe(1);
    expect(technical.f1).toBeCloseTo(0.8, 3);
  });

  it('gives macro and weighted averages that differ on imbalanced data', () => {
    const report = summarize(
      [
        prediction('a', 'a'),
        prediction('a', 'a'),
        prediction('a', 'a'),
        prediction('b', 'a'),
      ],
      1000,
    );
    expect(report.macro.f1).not.toBe(report.weighted.f1);
    expect(report.weighted.f1).toBeGreaterThan(report.macro.f1);
  });

  it('builds a confusion matrix keyed expected -> predicted', () => {
    const report = summarize(
      [prediction('a', 'a'), prediction('a', 'b'), prediction('b', 'b')],
      1000,
    );
    expect(report.confusion.a).toEqual({ a: 1, b: 1 });
    expect(report.confusion.b).toEqual({ a: 0, b: 1 });
  });

  it('separates confidence on correct and wrong predictions', () => {
    const report = summarize(
      [prediction('a', 'a', 0.95), prediction('a', 'b', 0.55)],
      1000,
    );
    expect(report.confidence.meanWhenCorrect).toBeCloseTo(0.95, 5);
    expect(report.confidence.meanWhenWrong).toBeCloseTo(0.55, 5);
    expect(report.confidence.mean).toBeCloseTo(0.75, 5);
  });

  it('reports latency percentiles from the measured values', () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const report = summarize(
      latencies.map((ms) => prediction('a', 'a', 0.9, ms)),
      1000,
    );
    expect(report.latency.minMs).toBe(10);
    expect(report.latency.maxMs).toBe(100);
    expect(report.latency.meanMs).toBe(55);
    expect(report.latency.p50Ms).toBe(50);
    expect(report.latency.p95Ms).toBe(100);
  });

  it('derives throughput from wall-clock time, not summed latency', () => {
    const report = summarize([prediction('a', 'a'), prediction('a', 'a')], 500);
    expect(report.throughput).toBeCloseTo(4, 5);
  });

  it('reports coverage and accuracy at each confidence threshold', () => {
    const report = summarize(
      [
        prediction('a', 'a', 0.95),
        prediction('a', 'a', 0.85),
        prediction('a', 'b', 0.55),
        prediction('b', 'a', 0.51),
      ],
      1000,
      [0.5, 0.8, 0.9],
    );

    const at80 = report.thresholds.find((t) => t.threshold === 0.8)!;
    expect(at80.coverage).toBe(0.5);
    expect(at80.accuracy).toBe(1);
    expect(at80.deferred).toBe(2);

    const at50 = report.thresholds.find((t) => t.threshold === 0.5)!;
    expect(at50.coverage).toBe(1);
    expect(at50.accuracy).toBe(0.5);
  });

  it('handles an empty prediction set without dividing by zero', () => {
    const report = summarize([], 1000);
    expect(report.total).toBe(0);
    expect(report.accuracy).toBe(0);
    expect(report.macro.f1).toBe(0);
    expect(report.latency.p50Ms).toBe(0);
  });

  it('excludes a never-expected label from the macro average', () => {
    // "c" is only ever predicted, never expected: it has no support.
    const report = summarize([prediction('a', 'a'), prediction('b', 'c')], 1000);
    const c = report.perLabel.find((m) => m.label === 'c')!;
    expect(c.support).toBe(0);
    expect(report.macro.precision).toBeCloseTo(0.5, 5);
  });
});

describe('percentile', () => {
  it('uses nearest-rank on sorted values', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 90)).toBe(9);
    expect(percentile(sorted, 100)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('parseDataset', () => {
  it('parses JSONL rows', () => {
    const rows = parseDataset(
      '{"input":"My payment failed","expected":"billing"}\n{"input":"The app crashes","expected":"technical"}\n',
    );
    expect(rows).toEqual([
      { input: 'My payment failed', expected: 'billing' },
      { input: 'The app crashes', expected: 'technical' },
    ]);
  });

  it('skips blank lines', () => {
    expect(parseDataset('\n{"input":"a","expected":"b"}\n\n')).toHaveLength(1);
  });

  it('accepts text/label aliases', () => {
    expect(parseDataset('{"text":"a","label":"b"}')).toEqual([{ input: 'a', expected: 'b' }]);
  });

  it('names the offending line number on malformed JSON', () => {
    expect(() => parseDataset('{"input":"a","expected":"b"}\nnot json')).toThrow(/line 2/);
  });

  it('rejects a row missing the required fields', () => {
    expect(() => parseDataset('{"input":"a"}')).toThrow(/needs string "input" and "expected"/);
  });
});
