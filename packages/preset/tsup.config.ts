import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/feature.ts',
    'src/profile.ts',
    'src/cost.ts',
    'src/preset/spreadsheet.ts',
    'src/preset/database-editor.ts',
    'src/preset/dashboard.ts',
    'src/preset/report.ts',
    'src/preset/mobile.ts',
    'src/preset/minimal.ts',
    'src/preset/analytics.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  splitting: false,
});
