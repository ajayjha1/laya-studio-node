import { readFile } from 'node:fs/promises';

import type { Laya, LayaQuestion } from '../../src/index.js';
import { flagBool, flagString, type ParsedArgs } from '../args.js';
import { bold, cyan, dim, json, percent, table } from '../output.js';
import { readInput } from '../client.js';

/**
 * `laya predict` — the raw passthrough.
 *
 * Takes Laya questions verbatim and prints the answers verbatim. Nothing is
 * reshaped, so this is the command to reach for when a question shape is not
 * covered by classify/decide/screen, and the one to use when reproducing a
 * request exactly.
 */
export async function predictCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const inline = flagString(args.flags, 'questions');
  const file = flagString(args.flags, 'questions-file');

  if (inline === undefined && file === undefined) {
    throw new Error(
      'Pass questions as JSON:\n' +
        `  laya predict "billed twice" --questions '{"dept":{"type":"choice",` +
        `"instructions":"which team?","criteria":["billing","technical"]}}'\n\n` +
        'Or from a file:\n' +
        '  laya predict "billed twice" --questions-file questions.json',
    );
  }

  // `--questions @file.json` is accepted too, since that habit is widespread.
  const source =
    file !== undefined
      ? await readFile(file, 'utf8')
      : inline!.startsWith('@')
        ? await readFile(inline!.slice(1), 'utf8')
        : inline!;

  let questions: Record<string, LayaQuestion>;
  try {
    questions = JSON.parse(source) as Record<string, LayaQuestion>;
  } catch (error) {
    throw new Error(`questions must be valid JSON: ${(error as Error).message}`);
  }

  const input = await readInput(args.positionals);
  const result = await laya.predict({ state: input, questions });

  if (flagBool(args.flags, 'json')) {
    // Exactly what the server returned, plus timing.
    console.log(json({ model: result.model, answers: result.answers, usage: result.usage, routing: result.routing }));
    return 0;
  }

  for (const [name, answer] of Object.entries(result.answers)) {
    console.log(bold(name) + dim(`  (${answer.type})`));

    if (answer.type === 'choice') {
      console.log(`  answer      ${cyan(answer.choice)}`);
      console.log(
        table(
          ['  option', 'probability'],
          Object.entries(answer.probabilities)
            .sort(([, a], [, b]) => b - a)
            .map(([label, probability]) => [`  ${label}`, percent(probability)]),
        ),
      );
    } else if (answer.type === 'score') {
      console.log(`  score       ${cyan(answer.score.toFixed(4))}`);
      console.log(`  legend      ${dim(JSON.stringify(answer.legend))}`);
    } else {
      console.log(`  noul        ${cyan(answer.noul.toFixed(4))} ${dim('P(yes)')}`);
    }

    console.log(
      dim(
        `  confidence ${answer.confidence}  answer_confidence ${answer.answer_confidence}` +
          `  act ${answer.action.act_probability}`,
      ),
    );
    console.log();
  }

  console.log(
    dim(
      `${Object.keys(result.answers).length} question(s) in one forward pass · ` +
        `${result.meta.latencyMs.toFixed(0)}ms · ${result.model}` +
        (result.usage ? ` · ${result.usage.input_tokens} input tokens` : ''),
    ),
  );
  return 0;
}
