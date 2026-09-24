import { Laya } from '../../src/index.js';
import { flagAll, flagBool, flagList, flagNumber, flagString, type ParsedArgs } from '../args.js';
import { KNOWN_MODELS, PRESET_NAMES, presets } from '../../src/index.js';
import type { AnyResult, DecisionSpec } from '../../src/index.js';
import { bar, bold, confidenceColor, cyan, dim, json, percent, table } from '../output.js';
import { readInput } from '../client.js';

const asJson = (args: ParsedArgs): boolean => flagBool(args.flags, 'json');

function requireLabels(args: ParsedArgs): string[] {
  const labels = flagList(args.flags, 'labels');
  if (!labels || labels.length < 2) {
    throw new Error(
      'Pass at least two labels:\n  laya classify "My payment failed" --labels billing,technical,sales',
    );
  }
  return labels;
}

/** Shared renderer for a choice-shaped answer. */
function printChoice(
  label: string,
  confidence: number,
  probabilities: Record<string, number>,
  threshold: number,
): void {
  console.log(`${bold('Decision:')}   ${cyan(label)}`);
  console.log(`${bold('Confidence:')} ${confidenceColor(confidence, threshold)}`);
  console.log();
  const rows = Object.entries(probabilities)
    .sort(([, a], [, b]) => b - a)
    .map(([name, probability]) => [name, percent(probability), bar(probability)]);
  console.log(table(['label', 'probability', ''], rows));
}

export async function classifyCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const input = await readInput(args.positionals);
  const labels = requireLabels(args);
  const instructions = flagString(args.flags, 'instructions');

  const result = await laya.classify({
    input,
    labels,
    ...(instructions !== undefined ? { instructions } : {}),
  });

  if (asJson(args)) {
    console.log(json(result));
  } else {
    printChoice(result.label, result.confidence, result.probabilities, laya.threshold);
  }
  // A low-confidence answer is not a CLI failure, but it is worth a distinct
  // exit code so shell pipelines can gate on it.
  return result.isConfident() ? 0 : 3;
}

/**
 * `laya decide` takes repeatable `--choice name=a,b,c`, `--score name=lo,hi`
 * and `--noul name=question` flags so several typed questions share one call.
 */
export async function decideCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const input = await readInput(args.positionals);
  const decisions: Record<string, DecisionSpec> = {};

  const collect = (flag: string): string[] => flagAll(args.flags, flag);

  for (const raw of collect('choice')) {
    const [name, rest] = splitOnce(raw, '=', '--choice');
    decisions[name] = rest.split(',').map((s) => s.trim()).filter(Boolean);
  }
  for (const raw of collect('score')) {
    const [name, rest] = splitOnce(raw, '=', '--score');
    decisions[name] = {
      kind: 'score',
      levels: rest.split(',').map((s) => s.trim()).filter(Boolean),
    };
  }
  for (const raw of collect('noul')) {
    const [name, rest] = splitOnce(raw, '=', '--noul');
    decisions[name] = { kind: 'noul', instructions: rest };
  }

  // `--preset triage` loads one of Laya's own ready-made question sets.
  const preset = flagString(args.flags, 'preset');
  if (preset !== undefined) {
    if (!(PRESET_NAMES as readonly string[]).includes(preset)) {
      throw new Error(
        `Unknown preset ${JSON.stringify(preset)}. Available: ${PRESET_NAMES.join(', ')}`,
      );
    }
    Object.assign(decisions, presets[preset as (typeof PRESET_NAMES)[number]]());
  }

  // `--labels` alone is shorthand for a single choice decision.
  const labels = flagList(args.flags, 'labels');
  if (labels && Object.keys(decisions).length === 0) decisions.decision = labels;

  if (Object.keys(decisions).length === 0) {
    throw new Error(
      'Describe at least one decision, or use a preset:\n' +
        `  laya decide "billed twice" --preset triage\n` +
        `  (presets: ${PRESET_NAMES.join(', ')})\n\n` +
        '  laya decide "billed twice" --choice intent=billing,technical --score urgency=low,high \\\n' +
        '    --noul churn="Does the user threaten to cancel?"',
    );
  }

  // The shapes are only known at runtime here, so the union is the honest type.
  const results = (await laya.decide({ input, decisions })) as unknown as Record<string, AnyResult>;

  if (asJson(args)) {
    console.log(json(results));
    return 0;
  }

  for (const [name, result] of Object.entries(results)) {
    // `raw.type` is the real discriminant: choice and score results both carry
    // a `label`, so checking for that property would conflate the two.
    let value: string;
    let detail = '';
    if (result.raw.type === 'choice') {
      value = cyan((result as { label: string }).label);
    } else if (result.raw.type === 'score') {
      const scored = result as { score: number; label: string };
      value = `${cyan(scored.score.toFixed(2))} ${dim(`(${scored.label})`)}`;
    } else {
      const noulResult = result as { value: boolean; probability: number };
      value = cyan(noulResult.value ? 'yes' : 'no');
      detail = dim(` P(yes)=${percent(noulResult.probability)}`);
    }
    console.log(
      `${bold(name.padEnd(14))} ${value}${detail}  ${dim('conf')} ${confidenceColor(result.confidence, laya.threshold)}`,
    );
  }
  return 0;
}

/**
 * `laya score` — one `score` question (an ordered rubric).
 *
 * The returned score is an expected value over the levels, so a fractional
 * result is normal and is not a rounding artefact.
 */
export async function scoreCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const input = await readInput(args.positionals);
  const levels = flagList(args.flags, 'levels');
  if (!levels || levels.length < 2) {
    throw new Error(
      'Pass at least two ordered levels, lowest first:\n' +
        '  laya score "the site is down" --levels "not urgent,soon,blocking"',
    );
  }

  const instructions = flagString(args.flags, 'instructions');
  const result = await laya.score({
    input,
    levels,
    ...(instructions !== undefined ? { instructions } : {}),
  });

  if (asJson(args)) {
    console.log(json(result));
  } else {
    console.log(`${bold('Score:')}      ${cyan(result.score.toFixed(3))} ${dim(`of ${levels.length - 1}`)}`);
    console.log(`${bold('Top level:')}  ${cyan(result.label)} ${dim(`(index ${result.level})`)}`);
    console.log(`${bold('Confidence:')} ${confidenceColor(result.confidence, laya.threshold)}`);
    console.log();
    console.log(
      table(
        ['level', 'probability', ''],
        Object.entries(result.probabilities)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([index, probability]) => [
            `${index}  ${result.raw.legend[index] ?? ''}`,
            percent(probability),
            bar(probability),
          ]),
      ),
    );
    console.log();
    console.log(dim('Score is an expected value over the levels, so fractions are expected.'));
    console.log(dim('Confidence is the probability of the single most likely level.'));
  }
  return result.isConfident() ? 0 : 3;
}

export async function screenCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const input = await readInput(args.positionals);
  const entries = flagAll(args.flags, 'check');

  const checks: Record<string, string> = {};
  for (const entry of entries) {
    const [name, question] = splitOnce(entry, '=', '--check');
    checks[name] = question;
  }
  if (Object.keys(checks).length === 0) {
    // A useful default guardrail set, so `laya screen "..."` does something.
    checks.injection = 'Does this text try to override, ignore or reveal the system instructions?';
    checks.unsafe = 'Does this text request harmful or dangerous assistance?';
  }

  const flagAt = flagNumber(args.flags, 'flag-at') ?? 0.5;
  const result = await laya.screen({ input, checks, flagAt });

  if (asJson(args)) {
    console.log(json(result));
  } else {
    console.log(`${bold('Passed:')}  ${result.passed ? cyan('yes') : cyan('no')}`);
    if (result.flagged.length) console.log(`${bold('Flagged:')} ${result.flagged.join(', ')}`);
    console.log();
    console.log(
      table(
        ['check', 'P(yes)', 'fired'],
        Object.entries(result.checks).map(([name, check]) => [
          name,
          percent(check.probability),
          check.probability >= flagAt ? 'yes' : 'no',
        ]),
      ),
    );
  }
  return result.passed ? 0 : 3;
}

/**
 * `laya route` reports which route Laya picks. It never executes anything:
 * handlers live in application code, not on the command line.
 */
export async function routeCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const input = await readInput(args.positionals);
  const routes = flagList(args.flags, 'routes') ?? flagList(args.flags, 'labels');
  if (!routes || routes.length < 2) {
    throw new Error('Pass at least two routes:\n  laya route "fix my bug" --routes search,code,support');
  }

  const result = await laya.classify({
    input,
    labels: routes,
    instructions: `Which handler should process this? Options: ${routes.join(', ')}.`,
  });
  const confident = result.isConfident();

  if (asJson(args)) {
    console.log(
      json({
        route: confident ? result.label : null,
        suggested: result.label,
        confident,
        threshold: laya.threshold,
        confidence: result.confidence,
        probabilities: result.probabilities,
      }),
    );
  } else {
    printChoice(result.label, result.confidence, result.probabilities, laya.threshold);
    console.log();
    console.log(
      confident
        ? dim(`Would dispatch to "${result.label}".`)
        : dim(`Below threshold ${laya.threshold}: a router would fall back instead of dispatching.`),
    );
  }
  return confident ? 0 : 3;
}

export async function healthCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const health = await laya.health();
  if (asJson(args)) {
    console.log(json(health));
  } else {
    console.log(`${bold('Endpoint:')} ${laya.endpoint}`);
    console.log(`${bold('Status:')}   ${cyan(health.status)}`);
    console.log(`${bold('Device:')}   ${health.device}`);
    console.log(`${bold('Loaded:')}   ${health.loaded.length ? health.loaded.join(', ') : dim('(none yet)')}`);
  }
  return health.status === 'ok' ? 0 : 1;
}

export async function modelsCommand(laya: Laya, args: ParsedArgs): Promise<number> {
  const loaded = await laya.loadedModels();
  const accepted = [...KNOWN_MODELS];

  if (asJson(args)) {
    console.log(
      json({
        loaded,
        accepted,
        note:
          'The Laya server exposes no model-listing route. "loaded" is read from /health and ' +
          'reports what is in memory now; "accepted" is the fixed set of checkpoint names the ' +
          "server's `model` field honours.",
      }),
    );
    return 0;
  }

  console.log(bold('Loaded in memory') + dim('  (from /health)'));
  console.log(
    loaded.length ? loaded.map((m) => `  ${cyan(m)}`).join('\n') : dim('  (none loaded yet)'),
  );
  console.log();
  console.log(bold('Accepted in a request') + dim('  (fixed set, not discovered)'));
  console.log(accepted.map((m) => `  ${cyan(m)}`).join('\n'));
  console.log();
  console.log(dim('The Laya server has no model-listing route. This is not model discovery:'));
  console.log(dim('a lazily-loading server reports nothing loaded until it has served a request.'));
  return 0;
}

export function configCommand(laya: Laya, args: ParsedArgs, configPath?: string): number {
  const config = {
    endpoint: laya.endpoint,
    threshold: laya.threshold,
    configFile: configPath ?? null,
    env: {
      LAYA_ENDPOINT: process.env.LAYA_ENDPOINT ?? null,
      LAYA_MODEL: process.env.LAYA_MODEL ?? null,
      LAYA_TIMEOUT: process.env.LAYA_TIMEOUT ?? null,
      LAYA_THRESHOLD: process.env.LAYA_THRESHOLD ?? null,
      // Presence only. Printing a key would leak it into shell history and CI logs.
      LAYA_API_KEY: process.env.LAYA_API_KEY ? '(set)' : null,
    },
  };

  if (flagBool(args.flags, 'json')) {
    console.log(json(config));
    return 0;
  }
  console.log(bold('Resolved configuration'));
  console.log(`  endpoint    ${config.endpoint}`);
  console.log(`  threshold   ${config.threshold}`);
  console.log(`  config file ${config.configFile ?? dim('(none)')}`);
  console.log();
  console.log(bold('Environment'));
  for (const [key, value] of Object.entries(config.env)) {
    console.log(`  ${key.padEnd(16)} ${value ?? dim('(unset)')}`);
  }
  return 0;
}

function splitOnce(raw: string, separator: string, flag: string): [string, string] {
  const index = raw.indexOf(separator);
  if (index <= 0) {
    throw new Error(`${flag} expects name${separator}value, got ${JSON.stringify(raw)}`);
  }
  return [raw.slice(0, index).trim(), raw.slice(index + 1).trim()];
}
