import { readFile } from 'node:fs/promises';

import type { Laya } from '../../src/index.js';
import { flagBool, flagList, flagNumber, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, dim, percent, table } from '../output.js';

/**
 * `laya batch file.jsonl --labels a,b,c`
 *
 * Reads one JSON object per line, classifies each, and writes results as JSONL
 * (with `--json`) or a table.
 */
export async function batchCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const file = args.positionals[0];
  if (!file) {
    throw new Error(
      'Pass a JSONL file:\n  laya batch inputs.jsonl --labels billing,technical\n\n' +
        'Each line: {"input":"My payment failed"}',
    );
  }

  const labels = flagList(args.flags, 'labels');
  if (!labels || labels.length < 2) throw new Error('Pass at least two labels with --labels.');

  const content = await readFile(file, 'utf8');
  const inputs: string[] = [];
  content.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        inputs.push(parsed);
        return;
      }
      const row = parsed as Record<string, unknown>;
      const input = row.input ?? row.text ?? row.state;
      if (typeof input !== 'string') throw new Error('no string "input" field');
      inputs.push(input);
    } catch (error) {
      throw new Error(`line ${index + 1}: ${(error as Error).message}`);
    }
  });

  if (inputs.length === 0) throw new Error(`${file} contains no rows.`);

  const concurrency = flagNumber(args.flags, 'concurrency') ?? 8;
  const instructions = flagString(args.flags, 'instructions');
  const asJsonl = flagBool(args.flags, 'json');

  const startedAt = performance.now();
  const outcomes = await laya.batch(
    inputs.map((input) => ({
      input,
      decisions: {
        label: instructions === undefined ? labels : { kind: 'choice' as const, labels, instructions },
      },
    })),
    { concurrency },
  );
  const elapsedMs = performance.now() - startedAt;

  if (asJsonl) {
    outcomes.forEach((outcome, index) => {
      console.log(
        JSON.stringify(
          outcome.ok
            ? {
                index,
                input: inputs[index],
                label: outcome.results.label.label,
                confidence: outcome.results.label.confidence,
                probabilities: outcome.results.label.probabilities,
              }
            : { index, input: inputs[index], error: (outcome.error as Error).message },
        ),
      );
    });
    return outcomes.every((o) => o.ok) ? 0 : 1;
  }

  const rows = outcomes.map((outcome, index) => {
    const input = (inputs[index] ?? '').slice(0, 44);
    return outcome.ok
      ? [String(index), input, cyan(outcome.results.label.label), percent(outcome.results.label.confidence)]
      : [String(index), input, 'ERROR', dim((outcome.error as Error).message.split('\n')[0] ?? '')];
  });

  console.log(table(['#', 'input', 'label', 'confidence'], rows));
  console.log();
  const failed = outcomes.filter((o) => !o.ok).length;
  console.log(
    `${bold('Done:')} ${outcomes.length - failed}/${outcomes.length} in ${(elapsedMs / 1000).toFixed(2)}s ` +
      dim(`(${((outcomes.length / elapsedMs) * 1000).toFixed(1)} rows/s at concurrency ${concurrency})`),
  );
  if (failed > 0) console.log(`${failed} row(s) failed.`);

  console.log(
    dim('\nThe Laya HTTP API takes one state per request, so these were issued as'),
  );
  console.log(dim(`${concurrency} concurrent requests rather than one batched call.`));

  return failed === 0 ? 0 : 1;
}
