import { readFile } from 'node:fs/promises';

import type { Laya } from '../../src/index.js';
import { parseDataset, summarize, type EvalPrediction } from '../../src/eval/metrics.js';
import { mapWithConcurrency } from '../../src/util/concurrency.js';
import { flagBool, flagList, flagNumber, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, dim, json, percent, table } from '../output.js';

/**
 * `laya eval dataset.jsonl`
 *
 * Every number printed comes from predictions actually made against the
 * configured endpoint. Nothing is simulated.
 */
export async function evalCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const file = args.positionals[0];
  if (!file) {
    throw new Error(
      'Pass a dataset:\n  laya eval dataset.jsonl --labels billing,technical\n\n' +
        'Each line: {"input":"My payment failed","expected":"billing"}',
    );
  }

  const rows = parseDataset(await readFile(file, 'utf8'));
  if (rows.length === 0) throw new Error(`${file} contains no rows.`);

  // Labels default to every distinct expected value in the dataset.
  const labels = flagList(args.flags, 'labels') ?? [...new Set(rows.map((r) => r.expected))].sort();
  if (labels.length < 2) {
    throw new Error('Need at least two labels. Pass --labels, or use a dataset with more than one class.');
  }

  const concurrency = flagNumber(args.flags, 'concurrency') ?? 4;
  const instructions = flagString(args.flags, 'instructions');
  const quiet = flagBool(args.flags, 'json');

  if (!quiet) {
    console.log(dim(`Evaluating ${rows.length} rows against ${laya.endpoint}`));
    console.log(dim(`Labels: ${labels.join(', ')}  ·  concurrency ${concurrency}`));
    console.log();
  }

  let completed = 0;
  const startedAt = performance.now();

  const predictions = await mapWithConcurrency(rows, concurrency, async (row) => {
    const rowStart = performance.now();
    const result = await laya.classify({
      input: row.input,
      labels,
      ...(instructions !== undefined ? { instructions } : {}),
    });
    const prediction: EvalPrediction = {
      expected: row.expected,
      predicted: result.label,
      confidence: result.confidence,
      latencyMs: performance.now() - rowStart,
    };
    completed++;
    if (!quiet && process.stdout.isTTY) {
      process.stdout.write(`\r${dim(`  ${completed}/${rows.length}`)}`);
    }
    return prediction;
  });

  const wallClockMs = performance.now() - startedAt;
  if (!quiet && process.stdout.isTTY) process.stdout.write('\r');

  const report = summarize(predictions, wallClockMs, flagList(args.flags, 'thresholds')?.map(Number));

  if (quiet) {
    console.log(json(report));
    return report.accuracy >= (flagNumber(args.flags, 'min-accuracy') ?? 0) ? 0 : 1;
  }

  console.log(bold('Overall'));
  console.log(`  accuracy    ${cyan(percent(report.accuracy))}  (${report.correct}/${report.total})`);
  console.log(`  macro F1    ${percent(report.macro.f1)}`);
  console.log(`  weighted F1 ${percent(report.weighted.f1)}`);
  console.log();

  console.log(bold('Per label'));
  console.log(
    table(
      ['label', 'support', 'precision', 'recall', 'F1'],
      report.perLabel.map((m) => [
        m.label,
        String(m.support),
        percent(m.precision),
        percent(m.recall),
        percent(m.f1),
      ]),
    ),
  );
  console.log();

  console.log(bold('Confusion matrix') + dim('  (rows = expected, columns = predicted)'));
  console.log(
    table(
      ['expected', ...report.labels],
      report.labels.map((expected) => [
        expected,
        ...report.labels.map((predicted) => String(report.confusion[expected]?.[predicted] ?? 0)),
      ]),
    ),
  );
  console.log();

  console.log(bold('Confidence'));
  console.log(`  mean           ${percent(report.confidence.mean)}`);
  console.log(`  when correct   ${percent(report.confidence.meanWhenCorrect)}`);
  console.log(`  when wrong     ${percent(report.confidence.meanWhenWrong)}`);
  console.log();

  console.log(bold('Threshold analysis') + dim('  (accuracy among rows kept at each threshold)'));
  console.log(
    table(
      ['threshold', 'coverage', 'accuracy', 'deferred'],
      report.thresholds.map((point) => [
        point.threshold.toFixed(2),
        percent(point.coverage),
        percent(point.accuracy),
        String(point.deferred),
      ]),
    ),
  );
  console.log();

  console.log(bold('Latency') + dim('  (end-to-end per request: network + inference + SDK)'));
  console.log(
    `  p50 ${report.latency.p50Ms.toFixed(1)}ms   p95 ${report.latency.p95Ms.toFixed(1)}ms   ` +
      `p99 ${report.latency.p99Ms.toFixed(1)}ms`,
  );
  console.log(
    `  throughput ${report.throughput.toFixed(1)} rows/s ` +
      dim(`over ${(wallClockMs / 1000).toFixed(1)}s wall clock at concurrency ${concurrency}`),
  );

  const minAccuracy = flagNumber(args.flags, 'min-accuracy');
  if (minAccuracy !== undefined && report.accuracy < minAccuracy) {
    console.log();
    console.log(`accuracy ${percent(report.accuracy)} is below --min-accuracy ${percent(minAccuracy)}`);
    return 1;
  }
  return 0;
}
