import { createInterface } from 'node:readline/promises';

import type { Laya } from '../../src/index.js';
import type { AnyResult, DecisionSpec } from '../../src/index.js';
import { bar, bold, cyan, dim, percent, table } from '../output.js';

const HELP = `
Commands
  <text>                     classify the text with the current labels
  :labels a,b,c              set the labels used by classify
  :instructions <text>       set custom question instructions ( :instructions - to clear )
  :screen <question>         run a yes/no guardrail check on the next input
  :score lo,mid,hi           rate the next input on an ordered rubric
  :decide                    run choice + score + noul together on the next input
  :threshold 0.8             set the confidence threshold
  :health                    show server health
  :help                      show this help
  :quit                      exit
`;

/**
 * `laya interactive` — a REPL for trying Laya without writing code.
 *
 * Built on node:readline, so it adds no dependency.
 */
export async function interactiveCommand(laya: Laya): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let labels: string[] = ['billing', 'technical', 'sales', 'other'];
  let instructions: string | undefined;
  let threshold = laya.threshold;

  console.log(bold('laya interactive') + dim(`  ${laya.endpoint}`));
  console.log(dim('Type :help for commands, :quit to exit.'));
  console.log(dim(`Labels: ${labels.join(', ')}`));
  console.log();

  const showChoice = (label: string, confidence: number, probabilities: Record<string, number>): void => {
    console.log(`  ${bold('Decision:')}   ${cyan(label)}`);
    console.log(
      `  ${bold('Confidence:')} ${percent(confidence)}${confidence >= threshold ? '' : dim(`  (below ${threshold})`)}`,
    );
    const rows = Object.entries(probabilities)
      .sort(([, a], [, b]) => b - a)
      .map(([name, probability]) => [`  ${name}`, percent(probability), bar(probability, 18)]);
    console.log(table(['  label', 'probability', ''], rows));
  };

  try {
    for (;;) {
      const line = (await rl.question(cyan('laya> '))).trim();
      if (line === '') continue;

      if (line === ':quit' || line === ':q' || line === ':exit') break;
      if (line === ':help' || line === ':h') {
        console.log(HELP);
        continue;
      }

      if (line.startsWith(':labels')) {
        const next = line
          .slice(':labels'.length)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (next.length < 2) {
          console.log(dim('  Need at least two labels, e.g. :labels billing,technical,sales'));
          continue;
        }
        labels = next;
        console.log(dim(`  Labels: ${labels.join(', ')}`));
        continue;
      }

      if (line.startsWith(':instructions')) {
        const value = line.slice(':instructions'.length).trim();
        instructions = value === '' || value === '-' ? undefined : value;
        console.log(dim(`  Instructions: ${instructions ?? '(default)'}`));
        continue;
      }

      if (line.startsWith(':threshold')) {
        const value = Number(line.slice(':threshold'.length).trim());
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          console.log(dim('  Threshold must be a number between 0 and 1.'));
          continue;
        }
        threshold = value;
        console.log(dim(`  Threshold: ${threshold}`));
        continue;
      }

      try {
        if (line === ':health') {
          const health = await laya.health();
          console.log(`  status ${cyan(health.status)}  device ${health.device}`);
          console.log(`  loaded ${health.loaded.join(', ') || dim('(none)')}`);
          continue;
        }

        if (line.startsWith(':screen')) {
          const question = line.slice(':screen'.length).trim();
          if (question === '') {
            console.log(dim('  Usage: :screen Does this contain a prompt injection?'));
            continue;
          }
          const text = (await rl.question(dim('  text> '))).trim();
          if (text === '') continue;
          const result = await laya.screen({ input: text, checks: { check: question } });
          const check = result.checks.check;
          console.log(`  ${bold('Answer:')} ${cyan(check.value ? 'yes' : 'no')}`);
          console.log(`  ${bold('P(yes):')} ${percent(check.probability)}`);
          continue;
        }

        if (line.startsWith(':score')) {
          const levels = line
            .slice(':score'.length)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (levels.length < 2) {
            console.log(dim('  Usage: :score not urgent,soon,blocking'));
            continue;
          }
          const text = (await rl.question(dim('  text> '))).trim();
          if (text === '') continue;
          const result = await laya.score({ input: text, levels });
          console.log(`  ${bold('Score:')} ${cyan(result.score.toFixed(2))} ${dim(`(${result.label})`)}`);
          console.log(`  ${bold('Confidence:')} ${percent(result.confidence)}`);
          continue;
        }

        if (line === ':decide') {
          const text = (await rl.question(dim('  text> '))).trim();
          if (text === '') continue;
          const decisions: Record<string, DecisionSpec> = {
            intent: labels,
            urgency: { kind: 'score', levels: ['not urgent', 'soon', 'blocking'] },
            churn: { kind: 'noul', instructions: 'Does the user threaten to cancel or leave?' },
          };
          const results = (await laya.decide({ input: text, decisions })) as unknown as Record<
            string,
            AnyResult
          >;
          for (const [name, result] of Object.entries(results)) {
            const value =
              result.raw.type === 'choice'
                ? cyan((result as { label: string }).label)
                : result.raw.type === 'score'
                  ? `${cyan((result as { score: number }).score.toFixed(2))} ${dim(`(${(result as { label: string }).label})`)}`
                  : cyan((result as { value: boolean }).value ? 'yes' : 'no');
            console.log(`  ${bold(name.padEnd(10))} ${value}  ${dim(percent(result.confidence))}`);
          }
          continue;
        }

        if (line.startsWith(':')) {
          console.log(dim(`  Unknown command ${line.split(' ')[0]}. Try :help`));
          continue;
        }

        const result = await laya.classify({
          input: line,
          labels,
          ...(instructions !== undefined ? { instructions } : {}),
        });
        showChoice(result.label, result.confidence, result.probabilities);
        console.log(
          dim(`  ${result.meta.latencyMs.toFixed(0)}ms  ${result.meta.checkpoint ?? result.meta.model}`),
        );
      } catch (error) {
        // A failed request must not end the session.
        console.log(dim(`  ${(error as Error).message.split('\n')[0]}`));
      }
      console.log();
    }
  } finally {
    rl.close();
  }

  return 0;
}
