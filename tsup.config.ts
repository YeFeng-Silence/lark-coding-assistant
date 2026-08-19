import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/daemon-entry.ts', 'src/hook-entry.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
