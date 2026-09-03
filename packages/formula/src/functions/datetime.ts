// =============================================================================
// Date / time category — the v1.0 base set: TODAY/NOW/YEAR/MONTH/DAY.
// Always bundled. The v1.1 expansion lives in `datetime_v11.ts`.
// =============================================================================

import { toBoolean, toNumber, toString_ } from '../coerce';
import {
  type FormulaError,
  NUM_ERROR,
  VALUE_ERROR,
  isFormulaError,
} from '../errors';
import {
  MS_PER_DAY,
  addDays,
  addMonths,
  daysBetween,
  getFunction,
  isLeapYear,
  register,
  toDate,
} from './_shared';

register('TODAY', () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
});

register('NOW', () => new Date());

register('YEAR', (args) => {
  const d = toDate(args[0]);
  return d instanceof Date ? d.getFullYear() : d;
});

register('MONTH', (args) => {
  const d = toDate(args[0]);
  return d instanceof Date ? d.getMonth() + 1 : d;
});

register('DAY', (args) => {
  const d = toDate(args[0]);
  return d instanceof Date ? d.getDate() : d;
});
