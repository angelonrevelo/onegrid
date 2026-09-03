// =============================================================================
// Text category — the v1.0 base set: LEN/UPPER/LOWER/TRIM/CONCAT/LEFT/RIGHT/
// MID/FIND/SUBSTITUTE. Always bundled. The v1.1 expansion lives in
// `text_v11.ts` behind a sub-path import.
// =============================================================================

import { toBoolean, toNumber, toString_ } from '../coerce';
import { NA_ERROR, VALUE_ERROR, isFormulaError } from '../errors';
import { flatten, register } from './_shared';

register('LEN', (args) => toString_(args[0]).length);
register('UPPER', (args) => toString_(args[0]).toUpperCase());
register('LOWER', (args) => toString_(args[0]).toLowerCase());
register('TRIM', (args) => toString_(args[0]).trim());

register('CONCAT', (args) => {
  let out = '';
  for (const a of flatten(args)) {
    if (isFormulaError(a)) return a;
    out += toString_(a);
  }
  return out;
});

register('LEFT', (args) => {
  const s = toString_(args[0]);
  const n = args.length > 1 ? toNumber(args[1]) : 1;
  if (isFormulaError(n)) return n;
  return s.slice(0, Math.max(0, n));
});

register('RIGHT', (args) => {
  const s = toString_(args[0]);
  const n = args.length > 1 ? toNumber(args[1]) : 1;
  if (isFormulaError(n)) return n;
  if (n <= 0) return '';
  return s.slice(-n);
});

register('MID', (args) => {
  const s = toString_(args[0]);
  const start = toNumber(args[1]);
  const len = toNumber(args[2]);
  if (isFormulaError(start) || isFormulaError(len)) return VALUE_ERROR;
  if (start < 1 || len < 0) return VALUE_ERROR;
  return s.slice(start - 1, start - 1 + len);
});

register('FIND', (args) => {
  const needle = toString_(args[0]);
  const haystack = toString_(args[1]);
  const startAt = args.length > 2 ? toNumber(args[2]) : 1;
  if (isFormulaError(startAt)) return startAt;
  const idx = haystack.indexOf(needle, Math.max(0, startAt - 1));
  return idx < 0 ? VALUE_ERROR : idx + 1;
});

register('SUBSTITUTE', (args) => {
  const s = toString_(args[0]);
  const from = toString_(args[1]);
  const to = toString_(args[2]);
  return s.split(from).join(to);
});
