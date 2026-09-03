// =============================================================================
// Math category (v1.1 expansion) — trigonometry, logs, rounding modes,
// combinatorics and the SUMPRODUCT family. Registered only when the adopter
// imports `@onegrid/formula/excel-compat` or `.../excel-compat/math`.
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

// ----- v1.1.0 expansion -----------------------------------------------------

register('PRODUCT', (args) => {
  const f = flattenNumbers(args);
  if (f.error) return f.error;
  if (f.values.length === 0) return 0;
  return f.values.reduce((a, b) => a * b, 1);
});

register('SUMSQ', (args) => {
  const f = flattenNumbers(args);
  if (f.error) return f.error;
  return f.values.reduce((acc, v) => acc + v * v, 0);
});

register('SUMPRODUCT', (args) => {
  // Element-wise across arrays of equal length, then sum.
  const arrays: number[][] = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      const inner = (a as unknown[]).flat();
      const nums: number[] = [];
      for (const v of inner) {
        const n = toNumber(v);
        nums.push(isFormulaError(n) ? 0 : n);
      }
      arrays.push(nums);
    } else {
      const n = toNumber(a);
      arrays.push([isFormulaError(n) ? 0 : n]);
    }
  }
  if (arrays.length === 0) return 0;
  const len = arrays[0]!.length;
  for (const arr of arrays) {
    if (arr.length !== len) return VALUE_ERROR;
  }
  let total = 0;
  for (let i = 0; i < len; i++) {
    let prod = 1;
    for (const arr of arrays) prod *= arr[i]!;
    total += prod;
  }
  return total;
});

register('GCD', (args) => {
  const f = flattenNumbers(args);
  if (f.error) return f.error;
  if (f.values.some((v) => v < 0)) return NUM_ERROR;
  const ints = f.values.map((v) => Math.trunc(v));
  if (ints.length === 0) return 0;
  const gcd2 = (a: number, b: number): number => (b === 0 ? a : gcd2(b, a % b));
  return ints.reduce((a, b) => gcd2(a, b));
});

register('LCM', (args) => {
  const f = flattenNumbers(args);
  if (f.error) return f.error;
  if (f.values.some((v) => v < 0)) return NUM_ERROR;
  const ints = f.values.map((v) => Math.trunc(v));
  if (ints.length === 0) return 0;
  const gcd2 = (a: number, b: number): number => (b === 0 ? a : gcd2(b, a % b));
  return ints.reduce((a, b) => (a === 0 || b === 0 ? 0 : Math.abs(a * b) / gcd2(a, b)));
});

register('EXP', (args) => {
  const n = toNumber(args[0]);
  return isFormulaError(n) ? n : Math.exp(n);
});

register('LN', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  if (n <= 0) return NUM_ERROR;
  return Math.log(n);
});

register('LOG', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  if (n <= 0) return NUM_ERROR;
  const base = args.length > 1 ? toNumber(args[1]) : 10;
  if (isFormulaError(base)) return base;
  if (base <= 0 || base === 1) return NUM_ERROR;
  return Math.log(n) / Math.log(base);
});

register('LOG10', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  if (n <= 0) return NUM_ERROR;
  return Math.log10(n);
});

register('PI', () => Math.PI);

register('RADIANS', (args) => {
  const n = toNumber(args[0]);
  return isFormulaError(n) ? n : (n * Math.PI) / 180;
});

register('DEGREES', (args) => {
  const n = toNumber(args[0]);
  return isFormulaError(n) ? n : (n * 180) / Math.PI;
});

const trigUnary = (fn: (n: number) => number): FormulaFn => (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  const r = fn(n);
  return Number.isFinite(r) ? r : NUM_ERROR;
};

register('SIN', trigUnary(Math.sin));
register('COS', trigUnary(Math.cos));
register('TAN', trigUnary(Math.tan));
register('ASIN', trigUnary((n) => (n < -1 || n > 1 ? NaN : Math.asin(n))));
register('ACOS', trigUnary((n) => (n < -1 || n > 1 ? NaN : Math.acos(n))));
register('ATAN', trigUnary(Math.atan));
register('SINH', trigUnary(Math.sinh));
register('COSH', trigUnary(Math.cosh));
register('TANH', trigUnary(Math.tanh));
register('ASINH', trigUnary(Math.asinh));
register('ACOSH', trigUnary((n) => (n < 1 ? NaN : Math.acosh(n))));
register('ATANH', trigUnary((n) => (n <= -1 || n >= 1 ? NaN : Math.atanh(n))));

register('ATAN2', (args) => {
  // Excel's ATAN2 takes (x, y) — opposite of JS Math.atan2(y, x).
  const x = toNumber(args[0]);
  const y = toNumber(args[1]);
  if (isFormulaError(x)) return x;
  if (isFormulaError(y)) return y;
  if (x === 0 && y === 0) return DIV_ZERO;
  return Math.atan2(y, x);
});

register('RAND', () => Math.random());

register('RANDBETWEEN', (args) => {
  const lo = toNumber(args[0]);
  const hi = toNumber(args[1]);
  if (isFormulaError(lo)) return lo;
  if (isFormulaError(hi)) return hi;
  if (lo > hi) return NUM_ERROR;
  const loI = Math.ceil(lo);
  const hiI = Math.floor(hi);
  return Math.floor(Math.random() * (hiI - loI + 1)) + loI;
});

register('SIGN', (args) => {
  const n = toNumber(args[0]);
  return isFormulaError(n) ? n : Math.sign(n);
});

register('TRUNC', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  const digits = args.length > 1 ? toNumber(args[1]) : 0;
  if (isFormulaError(digits)) return digits;
  const p = Math.pow(10, digits);
  return Math.trunc(n * p) / p;
});

register('ROUNDDOWN', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  const digits = args.length > 1 ? toNumber(args[1]) : 0;
  if (isFormulaError(digits)) return digits;
  const p = Math.pow(10, digits);
  return (n >= 0 ? Math.floor(n * p) : Math.ceil(n * p)) / p;
});

register('ROUNDUP', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  const digits = args.length > 1 ? toNumber(args[1]) : 0;
  if (isFormulaError(digits)) return digits;
  const p = Math.pow(10, digits);
  return (n >= 0 ? Math.ceil(n * p) : Math.floor(n * p)) / p;
});

register('MROUND', (args) => {
  const n = toNumber(args[0]);
  const mult = toNumber(args[1]);
  if (isFormulaError(n)) return n;
  if (isFormulaError(mult)) return mult;
  if (mult === 0) return 0;
  if ((n < 0 && mult > 0) || (n > 0 && mult < 0)) return NUM_ERROR;
  return Math.round(n / mult) * mult;
});

register('EVEN', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  const sign = n < 0 ? -1 : 1;
  return sign * 2 * Math.ceil(Math.abs(n) / 2);
});

register('ODD', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  if (n === 0) return 1;
  const sign = n < 0 ? -1 : 1;
  const m = Math.ceil(Math.abs(n));
  return sign * (m % 2 === 0 ? m + 1 : m);
});

register('SQRTPI', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  if (n < 0) return NUM_ERROR;
  return Math.sqrt(n * Math.PI);
});

register('FACT', (args) => {
  const n = toNumber(args[0]);
  if (isFormulaError(n)) return n;
  if (n < 0) return NUM_ERROR;
  const k = Math.trunc(n);
  let r = 1;
  for (let i = 2; i <= k; i++) r *= i;
  return r;
});

register('COMBIN', (args) => {
  const n = toNumber(args[0]);
  const k = toNumber(args[1]);
  if (isFormulaError(n)) return n;
  if (isFormulaError(k)) return k;
  const ni = Math.trunc(n);
  const ki = Math.trunc(k);
  if (ni < 0 || ki < 0 || ki > ni) return NUM_ERROR;
  if (ki === 0 || ki === ni) return 1;
  let r = 1;
  const kk = Math.min(ki, ni - ki);
  for (let i = 1; i <= kk; i++) r = (r * (ni - kk + i)) / i;
  return r;
});

register('PERMUT', (args) => {
  const n = toNumber(args[0]);
  const k = toNumber(args[1]);
  if (isFormulaError(n)) return n;
  if (isFormulaError(k)) return k;
  const ni = Math.trunc(n);
  const ki = Math.trunc(k);
  if (ni < 0 || ki < 0 || ki > ni) return NUM_ERROR;
  let r = 1;
  for (let i = 0; i < ki; i++) r *= ni - i;
  return r;
});
