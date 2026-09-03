// =============================================================================
// Math category — the v1.0 base set: SUM/AVERAGE/COUNT/COUNTA/MIN/MAX/ABS/
// ROUND/FLOOR/CEILING/INT/SQRT/POWER/MOD. Always bundled.
// The v1.1 expansion lives in `math_v11.ts` behind a sub-path import.
// =============================================================================

import { toNumber } from '../coerce';
import { DIV_ZERO, NUM_ERROR, VALUE_ERROR, isFormulaError } from '../errors';
import {
  type FormulaFn,
  firstError,
  flatten,
  flattenNumbers,
  register,
} from './_shared';

register('SUM', (args) => {
  const f = flattenNumbers(args);
  if (f.error) return f.error;
  return f.values.reduce((a, b) => a + b, 0);
});

register('AVERAGE', (args) => {
  const f = flattenNumbers(args);
  if (f.error) return f.error;
  if (f.values.length === 0) return DIV_ZERO;
  return f.values.reduce((a, b) => a + b, 0) / f.values.length;
});

// AVG is aliased after AVERAGE registers; see ./_aliases.ts.

register('COUNT', (args) => {
  let n = 0;
  for (const a of flatten(args)) {
    if (typeof a === 'number') n++;
    else if (typeof a === 'string' && Number.isFinite(Number(a))) n++;
  }
  return n;
});

register('COUNTA', (args) => {
  let n = 0;
  for (const a of flatten(args)) {
    if (a !== null && a !== undefined && a !== '' && !isFormulaError(a)) n++;
  }
  return n;
});

register('MIN', (args) => {
  const f = flattenNumbers(args);
  if (f.error) return f.error;
  if (f.values.length === 0) return 0;
  return Math.min(...f.values);
});

register('MAX', (args) => {
  const f = flattenNumbers(args);
  if (f.error) return f.error;
  if (f.values.length === 0) return 0;
  return Math.max(...f.values);
});

register('ABS', (args) => {
  const err = firstError(args);
  if (err) return err;
  const n = toNumber(args[0]);
  return isFormulaError(n) ? n : Math.abs(n);
});

register('ROUND', (args) => {
  // Excel rounds half-away-from-zero: ROUND(2.5, 0) = 3, ROUND(-2.5, 0)
  // = -3. JS `Math.round` rounds half toward +∞ instead (so it would
  // give -2.5 → -2). Use the sign-preserving form.
  const err = firstError(args);
  if (err) return err;
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  const digits = args.length > 1 ? toNumber(args[1]) : 0;
  if (isFormulaError(digits)) return digits;
  const p = Math.pow(10, digits);
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * p)) / p;
});

register('FLOOR', (args) => {
  const n = toNumber(args[0]);
  return isFormulaError(n) ? n : Math.floor(n);
});

register('CEILING', (args) => {
  const n = toNumber(args[0]);
  return isFormulaError(n) ? n : Math.ceil(n);
});

register('INT', (args) => {
  // Excel-compat: INT rounds toward negative infinity, not toward zero.
  // INT(-2.5) = -3, INT(2.5) = 2. Differs from TRUNC which always rounds
  // toward zero (TRUNC(-2.5) = -2).
  const n = toNumber(args[0]);
  return isFormulaError(n) ? n : Math.floor(n);
});

register('SQRT', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  if (n < 0) return NUM_ERROR;
  return Math.sqrt(n);
});

register('POWER', (args) => {
  const base = toNumber(args[0]);
  const exp = toNumber(args[1]);
  if (isFormulaError(base)) return base;
  if (isFormulaError(exp)) return exp;
  return Math.pow(base, exp);
});

register('MOD', (args) => {
  const a = toNumber(args[0]);
  const b = toNumber(args[1]);
  if (isFormulaError(a)) return a;
  if (isFormulaError(b)) return b;
  if (b === 0) return DIV_ZERO;
  return a - Math.floor(a / b) * b;
});
