/**
 * Cache interface. The built-in store is in-memory; Redis or any other backend
 * plugs in by implementing this and passing it as `cache.store`.
 */
export interface LayaCache {
  get(key: string): Promise<unknown | undefined> | unknown | undefined;
  /** `ttlSeconds` is advisory; a store may apply its own policy. */
  set(key: string, value: unknown, ttlSeconds: number): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
  clear?(): Promise<void> | void;
}

export { MemoryCache } from './memory.js';
export { cacheKey } from './key.js';
