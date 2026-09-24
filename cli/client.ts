import { pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Laya, type LayaConfig } from '../src/index.js';
import { flagNumber, flagString, type ParsedArgs } from './args.js';

const CONFIG_FILES = ['laya.config.ts', 'laya.config.js', 'laya.config.mjs'];

/**
 * Load `laya.config.ts` if one exists next to the caller.
 *
 * `.ts` is only importable when the runtime can strip types (Node 22.6+ with
 * `--experimental-strip-types`, or tsx/bun). When it cannot, that is reported
 * as a hint rather than a crash — flags and environment still work.
 */
export async function loadConfigFile(cwd = process.cwd()): Promise<{ config: LayaConfig; path?: string; warning?: string }> {
  for (const name of CONFIG_FILES) {
    const path = resolve(cwd, name);
    try {
      await access(path);
    } catch {
      continue;
    }
    try {
      const loaded = (await import(pathToFileURL(path).href)) as { default?: LayaConfig };
      return { config: loaded.default ?? {}, path };
    } catch (error) {
      return {
        config: {},
        path,
        warning:
          `Found ${name} but could not load it: ${(error as Error).message}\n` +
          `  TypeScript config files need a runtime that strips types (Node 22.6+, tsx, or bun).`,
      };
    }
  }
  return { config: {} };
}

/** Build a client from config file < environment < flags. */
export async function clientFromArgs(args: ParsedArgs): Promise<{ laya: Laya; warning?: string }> {
  const { config, warning } = await loadConfigFile();

  const overrides: LayaConfig = { ...config };
  const endpoint = flagString(args.flags, 'endpoint');
  const apiKey = flagString(args.flags, 'api-key');
  const model = flagString(args.flags, 'model');
  const timeout = flagNumber(args.flags, 'timeout');
  const threshold = flagNumber(args.flags, 'threshold');

  if (endpoint !== undefined) overrides.endpoint = endpoint;
  if (apiKey !== undefined) overrides.apiKey = apiKey;
  if (model !== undefined) overrides.model = model;
  if (timeout !== undefined) overrides.timeout = timeout;
  if (threshold !== undefined) overrides.threshold = threshold;

  // resolveConfig inside Laya applies the environment beneath these.
  return warning === undefined ? { laya: new Laya(overrides) } : { laya: new Laya(overrides), warning };
}

/** Read the input text from a positional argument or from stdin when piped. */
export async function readInput(positionals: readonly string[]): Promise<string> {
  const direct = positionals.join(' ').trim();
  if (direct !== '') return direct;

  if (process.stdin.isTTY) {
    throw new Error('No input given. Pass it as an argument, or pipe it on stdin.');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') throw new Error('No input given on stdin.');
  return text;
}
