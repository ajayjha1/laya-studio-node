import { createHash } from 'node:crypto';

/**
 * Stable cache key for a request.
 *
 * Object keys are sorted at every level so that two semantically identical
 * requests written in different key orders share a cache entry. The state is
 * hashed rather than stored, so user input never sits in the key.
 */
export function cacheKey(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',');
  return `{${body}}`;
}
