import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  minify: false,
  // Bundle internal workspace packages (shipped as TS source) into the output.
  // @devflow/database is excluded: it resolves its migrations folder relative
  // to its own file location at runtime, which only works if it stays an
  // external (node_modules-resolved) package rather than getting inlined.
  noExternal: [/^@devflow\/(?!database)/],
});
