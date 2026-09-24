import { defineConfig } from 'laya-studio';

/**
 * `laya.config.ts` is picked up by the CLI from the working directory.
 * Flags override this file, and the environment sits between the two.
 *
 * Never put secrets here — read them from the environment.
 */
export default defineConfig({
  endpoint: 'http://localhost:8000',
  threshold: 0.8,
  timeout: 10_000,
  cache: { enabled: true, ttl: 300 },
});
