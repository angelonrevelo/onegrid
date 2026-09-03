import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/excel-compat.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  splitting: true,
});
