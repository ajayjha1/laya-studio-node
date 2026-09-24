import type { LayaCache } from './index.js';

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * In-memory TTL cache with a bounded entry count.
 *
 * Eviction is insertion-order (Map iteration), which approximates LRU closely
 * enough for a response cache and costs nothing to maintain.
 *
 * lean: single-process only. Swap in a shared store via `cache.store` when more
 * than one process needs to see the same entries.
 */
export class MemoryCache implements LayaCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(key: string): unknown | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency so a hot key is not evicted ahead of a cold one.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
