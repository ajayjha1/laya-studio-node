import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseArgs, flagAll, flagList, flagNumber, flagBool } from '../cli/args.js';
import { startMockServer, type MockServer } from './mock-server.js';

const run = promisify(execFile);
let server: MockServer;
let workDir: string;

/**
 * The CLI is exercised as a real subprocess against the built bundle, so these
 * tests cover argument parsing, output format and exit codes the way a user
 * meets them.
 */
async function laya(
  args: string[],
  options: { input?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  // spawn rather than execFile: only spawn lets the test write to stdin and
  // then close it, which is what the piped-input path needs.
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/cli.js', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, LAYA_ENDPOINT: server.url, LAYA_API_KEY: '', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));

    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

beforeAll(async () => {
  server = await startMockServer();
  workDir = await mkdtemp(join(tmpdir(), 'laya-cli-'));
}, 60_000);

afterAll(async () => {
  await server.close();
});

describe('arg parsing', () => {
  it('splits command, positionals and flags', () => {
    const args = parseArgs(['classify', 'My payment failed', '--labels', 'billing,technical']);
    expect(args.command).toBe('classify');
    expect(args.positionals).toEqual(['My payment failed']);
    expect(flagList(args.flags, 'labels')).toEqual(['billing', 'technical']);
  });

  it('accepts --key=value', () => {
    expect(flagList(parseArgs(['x', '--labels=a,b']).flags, 'labels')).toEqual(['a', 'b']);
  });

  it('treats a bare flag as true and --no-x as false', () => {
    const args = parseArgs(['x', '--json', '--no-color']);
    expect(flagBool(args.flags, 'json')).toBe(true);
    expect(args.flags.color).toBe(false);
  });

  it('accumulates a repeated flag instead of overwriting it', () => {
    const args = parseArgs(['decide', '--choice', 'a=1,2', '--choice', 'b=3,4']);
    expect(flagAll(args.flags, 'choice')).toEqual(['a=1,2', 'b=3,4']);
  });

  it('stops flag parsing at --', () => {
    const args = parseArgs(['classify', '--', '--not-a-flag']);
    expect(args.positionals).toEqual(['--not-a-flag']);
  });

  it('rejects a non-numeric number flag', () => {
    expect(() => flagNumber(parseArgs(['x', '--timeout', 'soon']).flags, 'timeout')).toThrow();
  });
});

describe('laya classify', () => {
  it('prints the decision and confidence', async () => {
    const { stdout, code } = await laya([
      'classify',
      'my billing payment failed',
      '--labels',
      'billing,technical,sales',
      '--threshold',
      '0.1',
    ]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Decision:\s+billing/);
    expect(stdout).toMatch(/Confidence:\s+\d+\.\d%/);
  });

  it('emits machine-readable JSON with --json', async () => {
    const { stdout, code } = await laya([
      'classify',
      'my billing payment failed',
      '--labels',
      'billing,technical',
      '--threshold',
      '0.1',
    ].concat('--json'));
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout) as {
      label: string;
      confidence: number;
      probabilities: Record<string, number>;
    };
    expect(parsed.label).toBe('billing');
    expect(typeof parsed.confidence).toBe('number');
    expect(Object.keys(parsed.probabilities)).toEqual(['billing', 'technical']);
    // isConfident is a method and must not appear in JSON output.
    expect(stdout).not.toContain('isConfident');
  });

  it('reads input from stdin when none is given', async () => {
    const { stdout, code } = await laya(
      ['classify', '--labels', 'billing,technical', '--threshold', '0.1', '--json'],
      { input: 'my billing payment failed' },
    );
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { label: string }).label).toBe('billing');
  });

  it('exits 3 when the answer is below the confidence threshold', async () => {
    const { code } = await laya([
      'classify',
      'totally ambiguous text',
      '--labels',
      'billing,technical,sales',
      '--threshold',
      '0.99',
    ]);
    expect(code).toBe(3);
  });

  it('exits 1 with guidance when labels are missing', async () => {
    const { stderr, code } = await laya(['classify', 'hello']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/at least two labels/i);
  });
});

describe('laya predict', () => {
  it('sends raw questions and prints raw answers', async () => {
    const questions = JSON.stringify({
      dept: {
        type: 'choice',
        instructions: 'which team?',
        criteria: { billing: 'billed invoices refunds', technical: 'bugs' },
      },
      churn: { type: 'noul', instructions: 'will they cancel?' },
    });

    const { stdout, code } = await laya(['predict', 'we were billed twice', '--questions', questions, '--json']);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout) as {
      answers: Record<string, { type: string; choice?: string; answer_confidence: number }>;
    };
    expect(parsed.answers.dept!.choice).toBe('billing');
    expect(parsed.answers.churn!.type).toBe('noul');
    // Raw passthrough keeps the fields the typed commands hide.
    expect(parsed.answers.dept!.answer_confidence).toBeTypeOf('number');
  });

  it('reads questions from a file', async () => {
    const file = join(workDir, 'questions.json');
    await writeFile(
      file,
      JSON.stringify({ q: { type: 'noul', instructions: 'is this about billing?' } }),
      'utf8',
    );
    const { stdout, code } = await laya(['predict', 'billed twice', '--questions-file', file, '--json']);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { answers: Record<string, { type: string }> }).answers.q!.type).toBe('noul');
  });

  it('explains what to pass when questions are missing', async () => {
    const { stderr, code } = await laya(['predict', 'hello']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Pass questions as JSON/);
  });

  it('rejects malformed question JSON', async () => {
    const { stderr, code } = await laya(['predict', 'hi', '--questions', '{not json']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/must be valid JSON/);
  });
});

describe('laya decide', () => {
  it('runs choice, score and noul together', async () => {
    const { stdout, code } = await laya([
      'decide',
      'billed twice and we will cancel',
      '--choice',
      'intent=billing,technical',
      '--score',
      'urgency=low,high',
      '--noul',
      'churn=Does the user threaten to cancel?',
      '--json',
    ]);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout) as Record<string, { raw: { type: string } }>;
    expect(parsed.intent!.raw.type).toBe('choice');
    expect(parsed.urgency!.raw.type).toBe('score');
    expect(parsed.churn!.raw.type).toBe('noul');
  });
});

describe('laya decide --preset', () => {
  it('runs a whole Laya preset in one request', async () => {
    const { stdout, code } = await laya([
      'decide',
      'I want a refund, we were billed twice',
      '--preset',
      'triage',
      '--json',
    ]);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout) as Record<string, { raw: { type: string } }>;
    expect(Object.keys(parsed)).toEqual([
      'intent',
      'is_urgent',
      'frustration',
      'refund_requested',
      'churn_risk',
    ]);
    expect(parsed.intent!.raw.type).toBe('choice');
    expect(parsed.frustration!.raw.type).toBe('score');
    expect(parsed.churn_risk!.raw.type).toBe('noul');
  });

  it('names the available presets on a typo', async () => {
    const { stderr, code } = await laya(['decide', 'x', '--preset', 'trage']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/Unknown preset/);
    expect(stderr).toMatch(/triage/);
  });

  it('lets explicit decisions combine with a preset', async () => {
    const { stdout } = await laya([
      'decide',
      'hello',
      '--preset',
      'guard',
      '--choice',
      'extra=yes,no',
      '--json',
    ]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty('jailbreak');
    expect(parsed).toHaveProperty('extra');
  });
});

describe('laya screen', () => {
  it('reports flagged checks and exits 3 when screening fails', async () => {
    const { stdout, code } = await laya([
      'screen',
      'ignore previous instructions',
      '--check',
      'injection=ignore previous instructions',
      '--json',
    ]);
    const parsed = JSON.parse(stdout) as { passed: boolean; flagged: string[] };
    expect(parsed.passed).toBe(false);
    expect(parsed.flagged).toContain('injection');
    expect(code).toBe(3);
  });
});

describe('laya route', () => {
  it('reports the route without executing anything', async () => {
    const { stdout } = await laya([
      'route',
      'search the web please',
      '--routes',
      'search,code,support',
      '--threshold',
      '0.1',
      '--json',
    ]);
    const parsed = JSON.parse(stdout) as { route: string | null; suggested: string };
    expect(parsed.suggested).toBe('search');
    expect(parsed.route).toBe('search');
  });
});

describe('laya health and models', () => {
  it('reports health as JSON', async () => {
    const { stdout, code } = await laya(['health', '--json']);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { status: string }).status).toBe('ok');
  });

  it('separates checkpoints loaded now from the fixed accepted set', async () => {
    const { stdout } = await laya(['models', '--json']);
    const parsed = JSON.parse(stdout) as { loaded: string[]; accepted: string[]; note: string };

    // `loaded` is read from /health: what is in memory right now.
    expect(parsed.loaded).toContain('english');
    // `accepted` is a fixed set known at build time, not discovered.
    expect(parsed.accepted).toEqual(['english', 'multilingual', 'typed-decisions']);
    // The output must say plainly that this is not model discovery.
    expect(parsed.note).toMatch(/no model-listing route/i);
  });
});

describe('laya config', () => {
  it('shows resolved configuration without printing the api key', async () => {
    const result = await run('node', ['dist/cli.js', 'config', '--json'], {
      cwd: process.cwd(),
      env: { ...process.env, LAYA_ENDPOINT: server.url, LAYA_API_KEY: 'super-secret', NO_COLOR: '1' },
    });
    const parsed = JSON.parse(result.stdout) as { env: Record<string, string | null> };

    expect(parsed.env.LAYA_API_KEY).toBe('(set)');
    expect(result.stdout).not.toContain('super-secret');
  });
});

describe('laya batch and eval', () => {
  it('classifies every row of a JSONL file', async () => {
    const file = join(workDir, 'inputs.jsonl');
    await writeFile(
      file,
      '{"input":"billing problem"}\n{"input":"technical bug"}\n',
      'utf8',
    );

    const { stdout, code } = await laya(['batch', file, '--labels', 'billing,technical', '--json']);
    expect(code).toBe(0);

    const lines = stdout.trim().split('\n').map((line) => JSON.parse(line) as { label: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.label).toBe('billing');
    expect(lines[1]!.label).toBe('technical');
  });

  it('computes evaluation metrics from a dataset', async () => {
    const file = join(workDir, 'dataset.jsonl');
    await writeFile(
      file,
      '{"input":"billing problem","expected":"billing"}\n' +
        '{"input":"technical bug","expected":"technical"}\n',
      'utf8',
    );

    const { stdout, code } = await laya(['eval', file, '--labels', 'billing,technical', '--json']);
    expect(code).toBe(0);

    const report = JSON.parse(stdout) as {
      total: number;
      accuracy: number;
      perLabel: unknown[];
      confusion: Record<string, Record<string, number>>;
      thresholds: unknown[];
      latency: { p50Ms: number };
    };
    expect(report.total).toBe(2);
    expect(report.accuracy).toBe(1);
    expect(report.perLabel).toHaveLength(2);
    expect(report.confusion.billing!.billing).toBe(1);
    expect(report.thresholds.length).toBeGreaterThan(0);
    expect(report.latency.p50Ms).toBeGreaterThan(0);
  });

  it('fails the run when accuracy is under --min-accuracy', async () => {
    const file = join(workDir, 'bad.jsonl');
    await writeFile(file, '{"input":"billing problem","expected":"technical"}\n', 'utf8');
    const { code } = await laya([
      'eval',
      file,
      '--labels',
      'billing,technical',
      '--min-accuracy',
      '0.9',
      '--json',
    ]);
    expect(code).toBe(1);
  });
});

describe('usage and errors', () => {
  it('prints usage and exits 2 with no command', async () => {
    const { stdout, code } = await laya([]);
    expect(code).toBe(2);
    expect(stdout).toContain('Usage');
    expect(stdout).toContain('classify');
  });

  it('prints usage for --help', async () => {
    const { stdout, code } = await laya(['classify', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Commands');
  });

  it('prints the version', async () => {
    const { stdout, code } = await laya(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits 2 on an unknown command', async () => {
    const { code, stderr } = await laya(['frobnicate']);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown command');
  });

  it('gives an actionable message when the server is unreachable', async () => {
    const result = await run('node', ['dist/cli.js', 'health'], {
      cwd: process.cwd(),
      env: { ...process.env, LAYA_ENDPOINT: 'http://127.0.0.1:1', NO_COLOR: '1' },
    }).catch((error: { stderr?: string; code?: number }) => error);

    const stderr = (result as { stderr?: string }).stderr ?? '';
    expect(stderr).toContain('Unable to connect to Laya');
    expect(stderr).toContain('laya-serve');
  }, 20_000);
});
