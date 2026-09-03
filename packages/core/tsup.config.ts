import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/feature/span.ts',
    'src/feature/damage.ts',
    'src/feature/conditional-format.ts',
    'src/feature/schema-evolution.ts',
    'src/feature/navigation-history.ts',
    'src/feature/reorder.ts',
    'src/feature/layout.ts',
    'src/feature/multi-select.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  splitting: false,
});
