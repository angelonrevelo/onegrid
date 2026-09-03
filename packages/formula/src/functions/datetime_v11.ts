// =============================================================================
// Date / time category (v1.1 expansion) — DATE/TIME/EDATE/EOMONTH/WORKDAY/
// NETWORKDAYS/YEARFRAC/DATEDIF and the rest.
// Registered only behind `@onegrid/formula/excel-compat[/datetime]`.
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

// ----- v1.1.0 expansion -----------------------------------------------------

function parseWeekendMask(arg: unknown): string | FormulaError {
  if (arg === null || arg === undefined) return '0000011';
  if (typeof arg === 'string' && /^[01]{7}$/.test(arg)) return arg;
  const n = toNumber(arg);
  if (isFormulaError(n)) return n;
  switch (Math.trunc(n)) {
    case 1: return '0000011';
    case 2: return '1000001';
    case 3: return '1100000';
    case 4: return '0110000';
    case 5: return '0011000';
    case 6: return '0001100';
    case 7: return '0000110';
    case 11: return '0000001';
    case 12: return '1000000';
    case 13: return '0100000';
    case 14: return '0010000';
    case 15: return '0001000';
    case 16: return '0000100';
    case 17: return '0000010';
    default: return NUM_ERROR;
  }
}

function isWeekend(d: Date, mask: string): boolean {
  const jsDay = d.getDay();
  const monIdx = (jsDay + 6) % 7;
  return mask[monIdx] === '1';
}

function collectHolidays(arg: unknown): Set<string> {
  const out = new Set<string>();
  if (arg === undefined || arg === null) return out;
  const flat = Array.isArray(arg) ? (arg as unknown[]).flat() : [arg];
  for (const v of flat) {
    const d = toDate(v);
    if (d instanceof Date) out.add(d.toDateString());
  }
  return out;
}

function endOfDiff(start: Date, end: Date, unit: 'year' | 'month'): number {
  if (unit === 'year') {
    let y = end.getFullYear() - start.getFullYear();
    if (
      end.getMonth() < start.getMonth() ||
      (end.getMonth() === start.getMonth() && end.getDate() < start.getDate())
    ) {
      y--;
    }
    return y;
  }
  let m = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) m--;
  return m;
}

register('DATE', (args) => {
  const y = toNumber(args[0]);
  const m = toNumber(args[1]);
  const day = toNumber(args[2]);
  if (isFormulaError(y)) return y;
  if (isFormulaError(m)) return m;
  if (isFormulaError(day)) return day;
  return new Date(Math.trunc(y), Math.trunc(m) - 1, Math.trunc(day));
});

register('TIME', (args) => {
  const h = toNumber(args[0]);
  const m = toNumber(args[1]);
  const s = toNumber(args[2]);
  if (isFormulaError(h)) return h;
  if (isFormulaError(m)) return m;
  if (isFormulaError(s)) return s;
  if (h < 0 || m < 0 || s < 0) return NUM_ERROR;
  return ((Math.trunc(h) % 24) * 3600 + (Math.trunc(m) % 60) * 60 + (Math.trunc(s) % 60)) / 86400;
});

register('DATEVALUE', (args) => {
  const s = toString_(args[0]);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return VALUE_ERROR;
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
});

register('TIMEVALUE', (args) => {
  const s = toString_(args[0]).trim();
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM|am|pm)?$/.exec(s);
  if (!m) {
    const t = Date.parse(`1970-01-01T${s}`);
    if (!Number.isFinite(t)) return VALUE_ERROR;
    const d = new Date(t);
    return (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) / 86400;
  }
  let h = Number(m[1]);
  const mm = Number(m[2]);
  const ss = m[3] ? Number(m[3]) : 0;
  const ampm = m[4]?.toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return (h * 3600 + mm * 60 + ss) / 86400;
});

register('HOUR', (args) => {
  const v = args[0];
  if (v instanceof Date) return v.getHours();
  if (typeof v === 'number') {
    const frac = v - Math.floor(v);
    return Math.floor(frac * 24);
  }
  const d = toDate(v);
  return d instanceof Date ? d.getHours() : d;
});

register('MINUTE', (args) => {
  const v = args[0];
  if (v instanceof Date) return v.getMinutes();
  if (typeof v === 'number') {
    const frac = v - Math.floor(v);
    return Math.floor((frac * 24 * 60) % 60);
  }
  const d = toDate(v);
  return d instanceof Date ? d.getMinutes() : d;
});

register('SECOND', (args) => {
  const v = args[0];
  if (v instanceof Date) return v.getSeconds();
  if (typeof v === 'number') {
    const frac = v - Math.floor(v);
    return Math.round((frac * 86400) % 60);
  }
  const d = toDate(v);
  return d instanceof Date ? d.getSeconds() : d;
});

register('WEEKDAY', (args) => {
  const d = toDate(args[0]);
  if (!(d instanceof Date)) return d;
  const js = d.getDay();
  const type = args.length > 1 ? toNumber(args[1]) : 1;
  if (isFormulaError(type)) return type;
  switch (Math.trunc(type)) {
    case 1: return js + 1;
    case 2: return ((js + 6) % 7) + 1;
    case 3: return (js + 6) % 7;
    case 11: return ((js + 6) % 7) + 1;
    case 12: return ((js + 5) % 7) + 1;
    case 13: return ((js + 4) % 7) + 1;
    case 14: return ((js + 3) % 7) + 1;
    case 15: return ((js + 2) % 7) + 1;
    case 16: return ((js + 1) % 7) + 1;
    case 17: return (js % 7) + 1;
    default: return NUM_ERROR;
  }
});

register('ISOWEEKNUM', (args) => {
  const d = toDate(args[0]);
  if (!(d instanceof Date)) return d;
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstThuDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstThuDay + 3);
  return 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * MS_PER_DAY));
});

register('WEEKNUM', (args) => {
  const d = toDate(args[0]);
  if (!(d instanceof Date)) return d;
  const returnType = args.length > 1 ? toNumber(args[1]) : 1;
  if (isFormulaError(returnType)) return returnType;
  if (returnType === 21) {
    return getFunction('ISOWEEKNUM')!([d]);
  }
  const startsMonday = returnType === 2 || returnType === 11;
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const jan1Day = jan1.getDay();
  const offset = startsMonday ? (jan1Day + 6) % 7 : jan1Day;
  const days = daysBetween(jan1, d);
  return Math.floor((days + offset) / 7) + 1;
});

register('DAYS', (args) => {
  const end = toDate(args[0]);
  const start = toDate(args[1]);
  if (!(end instanceof Date)) return end;
  if (!(start instanceof Date)) return start;
  return daysBetween(start, end);
});

register('DAYS360', (args) => {
  const start = toDate(args[0]);
  const end = toDate(args[1]);
  if (!(start instanceof Date)) return start;
  if (!(end instanceof Date)) return end;
  const european = args.length > 2 ? toBoolean(args[2]) : false;
  if (isFormulaError(european)) return european;
  let d1 = start.getDate();
  let d2 = end.getDate();
  const m1 = start.getMonth() + 1;
  const m2 = end.getMonth() + 1;
  const y1 = start.getFullYear();
  const y2 = end.getFullYear();
  if (european) {
    if (d1 === 31) d1 = 30;
    if (d2 === 31) d2 = 30;
  } else {
    const endOfFeb = (y: number, m: number) =>
      m === 2 && new Date(y, m, 0).getDate() === d1;
    if (endOfFeb(y1, m1) && endOfFeb(y2, m2)) d2 = 30;
    if (endOfFeb(y1, m1)) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
    if (d1 === 31) d1 = 30;
  }
  return 360 * (y2 - y1) + 30 * (m2 - m1) + (d2 - d1);
});

register('EDATE', (args) => {
  const start = toDate(args[0]);
  if (!(start instanceof Date)) return start;
  const months = toNumber(args[1]);
  if (isFormulaError(months)) return months;
  return addMonths(start, Math.trunc(months));
});

register('EOMONTH', (args) => {
  const start = toDate(args[0]);
  if (!(start instanceof Date)) return start;
  const months = toNumber(args[1]);
  if (isFormulaError(months)) return months;
  const shifted = addMonths(start, Math.trunc(months));
  return new Date(shifted.getFullYear(), shifted.getMonth() + 1, 0);
});

register('YEARFRAC', (args) => {
  const start = toDate(args[0]);
  const end = toDate(args[1]);
  if (!(start instanceof Date)) return start;
  if (!(end instanceof Date)) return end;
  const basis = args.length > 2 ? toNumber(args[2]) : 0;
  if (isFormulaError(basis)) return basis;
  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;
  switch (Math.trunc(basis)) {
    case 0: {
      const d = getFunction('DAYS360')!([lo, hi]);
      if (isFormulaError(d)) return d;
      return (d as number) / 360;
    }
    case 1: {
      const days = daysBetween(lo, hi);
      const ys = hi.getFullYear() - lo.getFullYear() + 1;
      let avgDays = 0;
      for (let y = lo.getFullYear(); y <= hi.getFullYear(); y++) {
        avgDays += isLeapYear(y) ? 366 : 365;
      }
      return days / (avgDays / ys);
    }
    case 2: return daysBetween(lo, hi) / 360;
    case 3: return daysBetween(lo, hi) / 365;
    case 4: {
      const d = getFunction('DAYS360')!([lo, hi, true]);
      if (isFormulaError(d)) return d;
      return (d as number) / 360;
    }
    default: return NUM_ERROR;
  }
});

register('DATEDIF', (args) => {
  const start = toDate(args[0]);
  const end = toDate(args[1]);
  if (!(start instanceof Date)) return start;
  if (!(end instanceof Date)) return end;
  const unit = toString_(args[2]).toUpperCase();
  if (end < start) return NUM_ERROR;
  switch (unit) {
    case 'Y': return endOfDiff(start, end, 'year');
    case 'M': return endOfDiff(start, end, 'month');
    case 'D': return daysBetween(start, end);
    case 'MD': {
      const ref = new Date(end.getFullYear(), end.getMonth(), start.getDate());
      let d = daysBetween(ref, end);
      if (d < 0) {
        const prevMonth = new Date(end.getFullYear(), end.getMonth() - 1, start.getDate());
        d = daysBetween(prevMonth, end);
      }
      return d;
    }
    case 'YM': {
      let m = end.getMonth() - start.getMonth();
      if (end.getDate() < start.getDate()) m--;
      return ((m % 12) + 12) % 12;
    }
    case 'YD': {
      const ref = new Date(
        start.getFullYear() + endOfDiff(start, end, 'year'),
        start.getMonth(),
        start.getDate(),
      );
      return daysBetween(ref, end);
    }
    default: return NUM_ERROR;
  }
});

register('NETWORKDAYS.INTL', (args) => {
  const start = toDate(args[0]);
  const end = toDate(args[1]);
  if (!(start instanceof Date)) return start;
  if (!(end instanceof Date)) return end;
  const mask = parseWeekendMask(args[2]);
  if (typeof mask !== 'string') return mask;
  const holidays = collectHolidays(args[3]);
  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;
  const sign = start <= end ? 1 : -1;
  let count = 0;
  let d = new Date(lo);
  d.setHours(0, 0, 0, 0);
  const stop = new Date(hi);
  stop.setHours(0, 0, 0, 0);
  while (d <= stop) {
    if (!isWeekend(d, mask) && !holidays.has(d.toDateString())) count++;
    d = addDays(d, 1);
  }
  return sign * count;
});

register('NETWORKDAYS', (args) => {
  const inner = getFunction('NETWORKDAYS.INTL')!;
  return inner([args[0], args[1], 1, args[2]]);
});

register('WORKDAY.INTL', (args) => {
  const start = toDate(args[0]);
  if (!(start instanceof Date)) return start;
  const days = toNumber(args[1]);
  if (isFormulaError(days)) return days;
  const mask = parseWeekendMask(args[2]);
  if (typeof mask !== 'string') return mask;
  const holidays = collectHolidays(args[3]);
  let n = Math.trunc(days);
  const step = n >= 0 ? 1 : -1;
  let d = new Date(start);
  d.setHours(0, 0, 0, 0);
  while (n !== 0) {
    d = addDays(d, step);
    if (!isWeekend(d, mask) && !holidays.has(d.toDateString())) n -= step;
  }
  return d;
});

register('WORKDAY', (args) => {
  const inner = getFunction('WORKDAY.INTL')!;
  return inner([args[0], args[1], 1, args[2]]);
});
