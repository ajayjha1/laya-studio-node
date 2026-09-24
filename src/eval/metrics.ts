/**
 * Classification metrics for `laya eval`.
 *
 * Everything here is computed from predictions the caller actually made. No
 * number in an {@link EvalReport} is estimated, extrapolated or defaulted.
 */

export interface EvalRow {
  input: string;
  expected: string;
}

export interface EvalPrediction {
  expected: string;
  predicted: string;
  confidence: number;
  latencyMs: number;
}

export interface LabelMetrics {
  label: string;
  support: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ThresholdPoint {
  threshold: number;
  /** Share of rows at or above the threshold. */
  coverage: number;
  /** Accuracy among only those rows. */
  accuracy: number;
  /** Rows that would be deferred to a fallback. */
  deferred: number;
}

export interface EvalReport {
  total: number;
  correct: number;
  accuracy: number;
  /** Unweighted mean over labels — every class counts the same. */
  macro: { precision: number; recall: number; f1: number };
  /** Support-weighted mean — reflects the actual label distribution. */
  weighted: { precision: number; recall: number; f1: number };
  perLabel: LabelMetrics[];
  /** `confusion[expected][predicted]` = count. */
  confusion: Record<string, Record<string, number>>;
  labels: string[];
  confidence: {
    mean: number;
    meanWhenCorrect: number;
    meanWhenWrong: number;
  };
  latency: {
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    minMs: number;
    maxMs: number;
  };
  /** Rows per second, measured over the whole run. */
  throughput: number;
  thresholds: ThresholdPoint[];
}

/** Nearest-rank percentile on an already-sorted ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

const safeDiv = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

/**
 * Build a full report from predictions.
 *
 * @param wallClockMs Total elapsed time for the run, used for throughput. Pass
 *   the real measured duration; summing per-row latency would overstate
 *   throughput whenever requests were run concurrently.
 */
export function summarize(
  predictions: readonly EvalPrediction[],
  wallClockMs: number,
  thresholds: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95],
): EvalReport {
  const total = predictions.length;
  const labels = [
    ...new Set(predictions.flatMap((p) => [p.expected, p.predicted])),
  ].sort();

  const confusion: Record<string, Record<string, number>> = {};
  for (const expected of labels) {
    confusion[expected] = Object.fromEntries(labels.map((l) => [l, 0]));
  }
  for (const p of predictions) {
    const row = confusion[p.expected];
    if (row) row[p.predicted] = (row[p.predicted] ?? 0) + 1;
  }

  const perLabel: LabelMetrics[] = labels.map((label) => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const p of predictions) {
      if (p.expected === label && p.predicted === label) truePositives++;
      else if (p.expected !== label && p.predicted === label) falsePositives++;
      else if (p.expected === label && p.predicted !== label) falseNegatives++;
    }
    const precision = safeDiv(truePositives, truePositives + falsePositives);
    const recall = safeDiv(truePositives, truePositives + falseNegatives);
    return {
      label,
      support: truePositives + falseNegatives,
      truePositives,
      falsePositives,
      falseNegatives,
      precision,
      recall,
      f1: safeDiv(2 * precision * recall, precision + recall),
    };
  });

  const correct = predictions.filter((p) => p.expected === p.predicted).length;
  // Labels that never appear as an expected value have no support and would
  // otherwise drag the macro average down for a class the data never tested.
  const supported = perLabel.filter((m) => m.support > 0);
  const supportTotal = supported.reduce((sum, m) => sum + m.support, 0);
  const mean = (pick: (m: LabelMetrics) => number): number =>
    safeDiv(supported.reduce((sum, m) => sum + pick(m), 0), supported.length);
  const weightedMean = (pick: (m: LabelMetrics) => number): number =>
    safeDiv(supported.reduce((sum, m) => sum + pick(m) * m.support, 0), supportTotal);

  const correctPredictions = predictions.filter((p) => p.expected === p.predicted);
  const wrongPredictions = predictions.filter((p) => p.expected !== p.predicted);
  const avg = (values: readonly number[]): number =>
    safeDiv(values.reduce((sum, v) => sum + v, 0), values.length);

  const latencies = predictions.map((p) => p.latencyMs).sort((a, b) => a - b);

  const thresholdPoints: ThresholdPoint[] = thresholds.map((threshold) => {
    const kept = predictions.filter((p) => p.confidence >= threshold);
    return {
      threshold,
      coverage: safeDiv(kept.length, total),
      accuracy: safeDiv(kept.filter((p) => p.expected === p.predicted).length, kept.length),
      deferred: total - kept.length,
    };
  });

  return {
    total,
    correct,
    accuracy: safeDiv(correct, total),
    macro: { precision: mean((m) => m.precision), recall: mean((m) => m.recall), f1: mean((m) => m.f1) },
    weighted: {
      precision: weightedMean((m) => m.precision),
      recall: weightedMean((m) => m.recall),
      f1: weightedMean((m) => m.f1),
    },
    perLabel,
    confusion,
    labels,
    confidence: {
      mean: avg(predictions.map((p) => p.confidence)),
      meanWhenCorrect: avg(correctPredictions.map((p) => p.confidence)),
      meanWhenWrong: avg(wrongPredictions.map((p) => p.confidence)),
    },
    latency: {
      meanMs: avg(latencies),
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      p99Ms: percentile(latencies, 99),
      minMs: latencies[0] ?? 0,
      maxMs: latencies[latencies.length - 1] ?? 0,
    },
    throughput: wallClockMs > 0 ? (total / wallClockMs) * 1000 : 0,
    thresholds: thresholdPoints,
  };
}

/** Parse a JSONL dataset of `{"input": ..., "expected": ...}` rows. */
export function parseDataset(content: string): EvalRow[] {
  const rows: EvalRow[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`dataset line ${i + 1} is not valid JSON: ${line.slice(0, 80)}`);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`dataset line ${i + 1} must be a JSON object`);
    }
    const row = parsed as Record<string, unknown>;
    const input = row.input ?? row.text ?? row.state;
    const expected = row.expected ?? row.label ?? row.gold;
    if (typeof input !== 'string' || typeof expected !== 'string') {
      throw new Error(
        `dataset line ${i + 1} needs string "input" and "expected" fields, got ${JSON.stringify(row).slice(0, 120)}`,
      );
    }
    rows.push({ input, expected });
  }
  return rows;
}

/** Convenience wrapper: run a predictor over rows, then summarize. */
export async function evaluate(
  rows: readonly EvalRow[],
  predict: (row: EvalRow) => Promise<{ predicted: string; confidence: number }>,
): Promise<EvalReport> {
  const startedAt = performance.now();
  const predictions: EvalPrediction[] = [];
  for (const row of rows) {
    const rowStart = performance.now();
    const { predicted, confidence } = await predict(row);
    predictions.push({
      expected: row.expected,
      predicted,
      confidence,
      latencyMs: performance.now() - rowStart,
    });
  }
  return summarize(predictions, performance.now() - startedAt);
}
