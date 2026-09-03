// =============================================================================
// Logical category — the v1.0 base set: IF/AND/OR/NOT/IFERROR/TRUE/FALSE.
// Always bundled. IFS/SWITCH/IFNA/XOR live in `logical_v11.ts`.
// =============================================================================

import { compare, toBoolean } from '../coerce';
import { NA_ERROR, isFormulaError } from '../errors';
import { flatten, register } from './_shared';

register('IF', (args) => {
  const test = toBoolean(args[0]);
  if (isFormulaError(test)) return test;
  return test ? args[1] : args.length > 2 ? args[2] : false;
});

register('AND', (args) => {
  for (const a of flatten(args)) {
    const b = toBoolean(a);
    if (isFormulaError(b)) return b;
    if (!b) return false;
  }
  return true;
});

register('OR', (args) => {
  for (const a of flatten(args)) {
    const b = toBoolean(a);
    if (isFormulaError(b)) return b;
    if (b) return true;
  }
  return false;
});

register('NOT', (args) => {
  const b = toBoolean(args[0]);
  return isFormulaError(b) ? b : !b;
});

register('IFERROR', (args) => {
  const v = args[0];
  if (isFormulaError(v)) return args[1] ?? '';
  return v;
});

register('TRUE', () => true);
register('FALSE', () => false);
