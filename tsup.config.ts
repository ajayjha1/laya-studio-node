import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Library entries: dual ESM/CJS so the package drops into both module systems.
    entry: {
      index: 'src/index.ts',
      express: 'integrations/express/index.ts',
      fastify: 'integrations/fastify/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: 'node18',
  },
  {
    // Executables: ESM only. Nothing imports these, so CJS copies and .d.ts
    // files would only add weight to the tarball.
    entry: { cli: 'cli/index.ts', mcp: 'mcp/server.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    target: 'node18',
  },
]);
