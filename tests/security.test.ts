import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { Laya } from '../src/index.js';
import { TOOL_DEFINITIONS } from '../mcp/tools.js';
import { startMockServer } from './mock-server.js';

/**
 * Security properties asserted against the **built** bundle where possible,
 * since that is what a user actually runs.
 */

const BUNDLES = ['dist/index.js', 'dist/index.cjs', 'dist/cli.js', 'dist/mcp.js'];

describe('no dynamic code execution in the published bundles', () => {
  it('contains no eval() or new Function()', async () => {
    for (const path of BUNDLES) {
      const source = await readFile(path, 'utf8');
      expect(source, `${path} must not call eval`).not.toMatch(/[^.\w]eval\s*\(/);
      expect(source, `${path} must not construct functions from strings`).not.toMatch(
        /new\s+Function\s*\(/,
      );
    }
  });

  it('never spawns a process', async () => {
    for (const path of BUNDLES) {
      const source = await readFile(path, 'utf8');
      for (const forbidden of ['child_process', 'execSync', 'spawnSync', 'execFile(']) {
        expect(source, `${path} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('ships no hardcoded credentials', async () => {
    for (const path of BUNDLES) {
      const source = await readFile(path, 'utf8');
      expect(source).not.toMatch(/['"]sk-[A-Za-z0-9]{16,}/);
      expect(source).not.toMatch(/(api[_-]?key|secret)["' ]*[:=]["' ]*[A-Za-z0-9_-]{16,}/i);
    }
  });
});

describe('MCP exposes no execution surface', () => {
  it('declares a closed allowlist of laya_* tools only', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^laya_[a-z]+$/);
      // A closed schema: a client cannot smuggle extra top-level parameters.
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('has no tool parameter that names a command, path or code', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const properties = Object.keys(
        (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
      );
      for (const name of properties) {
        expect(
          ['command', 'cmd', 'shell', 'script', 'code', 'path', 'file', 'exec'],
          `${tool.name}.${name}`,
        ).not.toContain(name);
      }
    }
  });
});

describe('secrets and user input stay out of logs', () => {
  it('never puts the API key in an error message', async () => {
    const secured = await startMockServer({ apiKey: 'right-key' });
    const client = new Laya({ endpoint: secured.url, apiKey: 'super-secret-value', retries: 0 });

    const thrown: unknown = await client
      .classify({ input: 'x', labels: ['a', 'b'] })
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).not.toContain('super-secret-value');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
      'super-secret-value',
    );
    await secured.close();
  });

  it('never passes user input to any hook', async () => {
    const server = await startMockServer();
    const seen: unknown[] = [];
    const record = (meta: unknown): void => {
      seen.push(meta);
    };
    const client = new Laya({
      endpoint: server.url,
      retries: 0,
      hooks: { onRequest: record, onResponse: record, onError: record },
    });

    const secret = 'PATIENT-4417-DIAGNOSIS-CONFIDENTIAL';
    await client.classify({ input: secret, labels: ['a', 'b'] });
    await client.screen({ input: secret, checks: { c: 'is this sensitive?' } });

    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).not.toContain(secret);
    // Nor the answers, which can themselves be sensitive.
    expect(JSON.stringify(seen)).not.toContain('probabilities');
    await server.close();
  });

  it('keeps user input out of the cache key', async () => {
    const server = await startMockServer();
    const store = new Map<string, unknown>();
    const client = new Laya({
      endpoint: server.url,
      retries: 0,
      cache: {
        enabled: true,
        ttl: 60,
        store: {
          get: (key) => store.get(key),
          set: (key, value) => void store.set(key, value),
        },
      },
    });

    const secret = 'SSN-078-05-1120';
    await client.classify({ input: secret, labels: ['a', 'b'] });

    expect(store.size).toBe(1);
    // The key is a hash; the plaintext must not appear in it.
    for (const key of store.keys()) {
      expect(key).not.toContain(secret);
      expect(key).toMatch(/^[a-f0-9]{64}$/);
    }
    await server.close();
  });

  it('does not log anything on a normal successful call', async () => {
    const server = await startMockServer();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new Laya({ endpoint: server.url, retries: 0 });
    await client.classify({ input: 'quiet please', labels: ['a', 'b'] });

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
    await server.close();
  });
});

describe('Laya output is never an execution or authorization boundary', () => {
  it('a router cannot run a handler that was not registered', async () => {
    const rogue = await startMockServer({
      respondWith: {
        model: 'rogue',
        answers: {
          label: {
            type: 'choice',
            choice: 'process.exit',
            probabilities: { 'process.exit': 1 },
            confidence: 1,
            answer_confidence: 1,
            action: { act_probability: 1 },
          },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    const registered = vi.fn(async () => 'safe');
    const router = new Laya({ endpoint: rogue.url, retries: 0, threshold: 0 }).createRouter({
      routes: { safe: registered },
    });

    const result = await router.run('anything');
    expect(result.handled).toBe(false);
    expect(result.route).toBeNull();
    expect(registered).not.toHaveBeenCalled();
    await rogue.close();
  });
});
