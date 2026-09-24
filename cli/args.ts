/**
 * Minimal argv parser.
 *
 * A dependency-free CLI keeps `npm install laya-studio` to zero transitive
 * packages, and the surface needed here — flags, `--key value`, `--key=value`,
 * negation and positionals — is small enough not to warrant one.
 */
export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, FlagValue>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};

  /**
   * Repeating a flag accumulates rather than overwrites, so `--choice a=x,y
   * --choice b=p,q` describes two decisions instead of silently keeping the
   * last one.
   */
  const put = (name: string, value: string | boolean): void => {
    const existing = flags[name];
    if (existing === undefined) {
      flags[name] = value;
      return;
    }
    if (typeof value === 'boolean') {
      flags[name] = value;
      return;
    }
    flags[name] = Array.isArray(existing)
      ? [...existing, value]
      : [typeof existing === 'string' ? existing : String(existing), value];
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      if (equals !== -1) {
        put(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      if (body.startsWith('no-')) {
        flags[body.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        put(body, next);
        i++;
      } else {
        put(body, true);
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        put(body, next);
        i++;
      } else {
        put(body, true);
      }
      continue;
    }

    positionals.push(token);
  }

  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

export function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === 'string' ? value : undefined;
}

/** Every occurrence of a repeatable flag, in order. */
export function flagAll(flags: ParsedArgs['flags'], name: string): string[] {
  const value = flags[name];
  if (value === undefined || typeof value === 'boolean') return [];
  return Array.isArray(value) ? value : [value];
}

export function flagNumber(flags: ParsedArgs['flags'], name: string): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function flagBool(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

/** Split a comma-separated list, e.g. `--labels billing,technical`. */
export function flagList(flags: ParsedArgs['flags'], name: string): string[] | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}
