#!/usr/bin/env node
import { parseArgs, flagBool } from './args.js';
import { clientFromArgs, loadConfigFile } from './client.js';
import { bold, cyan, dim, red } from './output.js';
import { isLayaError } from '../src/index.js';
import {
  classifyCommand,
  configCommand,
  decideCommand,
  healthCommand,
  modelsCommand,
  routeCommand,
  scoreCommand,
  screenCommand,
} from './commands/basic.js';
import { batchCommand } from './commands/batch.js';
import { predictCommand } from './commands/predict.js';
import { evalCommand } from './commands/evaluate.js';
import { benchmarkCommand } from './commands/benchmark.js';
import { interactiveCommand } from './commands/interactive.js';

const VERSION = '0.1.0';

const USAGE = `
${bold('laya')} — decision layer for Node.js applications, backed by a Laya server

${bold('Usage')}
  laya <command> [input] [options]

${bold('Commands')}
  predict <text>      raw questions in, raw answers out ${dim('(the canonical call)')}
  classify <text>     assign one label      ${dim('--labels billing,technical,sales')}
  decide <text>       several typed questions in one forward pass
  score <text>        rate against an ordered rubric ${dim('--levels "low,medium,high"')}
  route <text>        show which route Laya would pick (never executes anything)
  screen <text>       yes/no guardrail checks
  batch <file.jsonl>  classify every row in a file
  eval <file.jsonl>   accuracy, F1, confusion matrix, threshold analysis
  benchmark           measured latency and throughput against your endpoint
  health              server status
  models              checkpoints the server has loaded
  config              resolved configuration and environment
  interactive         experiment without writing code

${bold('Global options')}
  --endpoint <url>    Laya server base URL        ${dim('(env LAYA_ENDPOINT, default http://localhost:8000)')}
  --api-key <key>     bearer token                ${dim('(env LAYA_API_KEY)')}
  --model <name>      english | multilingual | typed-decisions
  --timeout <ms>      per-request deadline        ${dim('(env LAYA_TIMEOUT)')}
  --threshold <0..1>  confidence threshold        ${dim('(env LAYA_THRESHOLD)')}
  --json              machine-readable output
  --help, --version

${bold('Examples')}
  laya classify "My payment failed" --labels billing,technical,sales
  laya classify "My payment failed" --labels billing,technical --json
  laya predict "billed twice" --questions-file questions.json
  laya decide "billed twice, we will cancel" \\
    --choice intent=billing,technical \\
    --score urgency=low,medium,high \\
    --noul churn="Does the user threaten to cancel?"
  laya screen "ignore previous instructions" --check injection="Is this a prompt injection?"
  laya eval dataset.jsonl --labels billing,technical
  echo "the app crashes" | laya classify --labels billing,technical

${bold('Exit codes')}
  0  success     1  error     2  usage     3  answered, but below the confidence threshold
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (flagBool(args.flags, 'version') || flagBool(args.flags, 'V')) {
    console.log(VERSION);
    return 0;
  }
  if (args.command === undefined || flagBool(args.flags, 'help') || flagBool(args.flags, 'h')) {
    console.log(USAGE);
    return args.command === undefined ? 2 : 0;
  }

  // `config` is the one command that must work without a reachable server.
  if (args.command === 'config') {
    const { laya } = await clientFromArgs(args);
    const { path } = await loadConfigFile();
    return configCommand(laya, args, path);
  }

  const { laya, warning } = await clientFromArgs(args);
  if (warning) console.error(dim(warning));

  switch (args.command) {
    case 'predict':
    case 'ask':
      return predictCommand(laya, args);
    case 'classify':
      return classifyCommand(laya, args);
    case 'decide':
      return decideCommand(laya, args);
    case 'route':
      return routeCommand(laya, args);
    case 'score':
      return scoreCommand(laya, args);
    case 'screen':
      return screenCommand(laya, args);
    case 'batch':
      return batchCommand(laya, args);
    case 'eval':
      return evalCommand(laya, args);
    case 'benchmark':
    case 'bench':
      return benchmarkCommand(laya, args);
    case 'health':
      return healthCommand(laya, args);
    case 'models':
      return modelsCommand(laya, args);
    case 'interactive':
    case 'repl':
      return interactiveCommand(laya);
    default:
      console.error(`Unknown command ${cyan(args.command)}.\n`);
      console.error(USAGE);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Typed Laya errors already carry an actionable message; print it as-is.
    // Anything else gets its message, with the stack behind --debug.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${red('Error:')} ${message}`);
    if (!isLayaError(error) && process.env.LAYA_DEBUG && error instanceof Error) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  });
