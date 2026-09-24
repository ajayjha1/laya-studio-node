import { describe, expect, it } from 'vitest';

import {
  DEFAULTS,
  Laya,
  LayaValidationError,
  MemoryCache,
  configFromEnv,
  defineConfig,
  resolveConfig,
} from '../src/index.js';

describe('configFromEnv', () => {
  it('reads every documented variable', () => {
    const config = configFromEnv({
      LAYA_ENDPOINT: 'http://example:9000',
      LAYA_API_KEY: 'secret',
      LAYA_MODEL: 'multilingual',
      LAYA_TIMEOUT: '25000',
      LAYA_THRESHOLD: '0.9',
    });
    expect(config).toEqual({
      endpoint: 'http://example:9000',
      apiKey: 'secret',
      model: 'multilingual',
      timeout: 25000,
      threshold: 0.9,
    });
  });

  it('returns nothing for an empty environment', () => {
    expect(configFromEnv({})).toEqual({});
  });

  it('rejects a non-numeric timeout instead of silently using a default', () => {
    expect(() => configFromEnv({ LAYA_TIMEOUT: 'soon' })).toThrow(/LAYA_TIMEOUT/);
  });

  it('ignores a blank value', () => {
    expect(configFromEnv({ LAYA_TIMEOUT: '   ' })).toEqual({});
  });
});

describe('resolveConfig', () => {
  it('lets explicit options win over the environment', () => {
    const config = resolveConfig(
      { endpoint: 'http://explicit:1' },
      { LAYA_ENDPOINT: 'http://env:2', LAYA_THRESHOLD: '0.7' },
    );
    expect(config.endpoint).toBe('http://explicit:1');
    expect(config.threshold).toBe(0.7);
  });
});

describe('defineConfig', () => {
  it('returns its input for laya.config.ts', () => {
    const config = { endpoint: 'http://x', threshold: 0.8, timeout: 10000 };
    expect(defineConfig(config)).toEqual(config);
  });
});

describe('Laya construction', () => {
  it('defaults to localhost:8000', () => {
    expect(new Laya().endpoint).toBe(DEFAULTS.endpoint);
  });

  it('strips a trailing slash from the endpoint', () => {
    expect(new Laya({ endpoint: 'http://x:8000/' }).endpoint).toBe('http://x:8000');
  });

  it('rejects a threshold outside 0..1', () => {
    expect(() => new Laya({ threshold: 1.5 })).toThrow(LayaValidationError);
    expect(() => new Laya({ threshold: -0.1 })).toThrow(LayaValidationError);
  });

  it('uses the documented defaults', () => {
    expect(new Laya().threshold).toBe(0.8);
    expect(DEFAULTS.timeout).toBe(10_000);
    expect(DEFAULTS.concurrency).toBe(8);
  });
});

describe('MemoryCache', () => {
  it('stores and returns a value', () => {
    const cache = new MemoryCache();
    cache.set('k', { v: 1 }, 60);
    expect(cache.get('k')).toEqual({ v: 1 });
  });

  it('expires an entry after its ttl', async () => {
    const cache = new MemoryCache();
    cache.set('k', 'v', 0.02);
    expect(cache.get('k')).toBe('v');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(cache.get('k')).toBeUndefined();
  });

  it('ignores a non-positive ttl', () => {
    const cache = new MemoryCache();
    cache.set('k', 'v', 0);
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the oldest entry when full', () => {
    const cache = new MemoryCache(2);
    cache.set('a', 1, 60);
    cache.set('b', 2, 60);
    cache.set('c', 3, 60);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('keeps a recently read entry alive under pressure', () => {
    const cache = new MemoryCache(2);
    cache.set('a', 1, 60);
    cache.set('b', 2, 60);
    cache.get('a'); // refresh recency
    cache.set('c', 3, 60);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
  });

  it('clears and deletes', () => {
    const cache = new MemoryCache();
    cache.set('a', 1, 60);
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    cache.set('b', 2, 60);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
