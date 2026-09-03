// =============================================================================
// Structured logging with redaction ON BY DEFAULT
//
// A grid holds customer data. An error report from a grid therefore holds
// customer data unless something stops it, and the natural thing to attach to a
// "cell renderer threw" report is the cell's value — which is exactly the field
// that must never leave the browser. Every logger created by this module
// redacts a default set of value-bearing field names before a record reaches a
// sink. Opting OUT is explicit and per-logger; there is no global escape hatch.
//
// Design decisions:
//
//   - Redaction happens in the logger, not in the sink. Sinks are adopter code
//     and third-party transports; by the time a record reaches one it is too
//     late to be careful. A `LogRecord` handed to a sink is already clean.
//
//   - The default deny-list is field NAMES, not value heuristics. Name matching
//     is predictable and cheap; regex-sniffing values for anything that looks
//     like an email is neither, and it fails open. `value`, `oldValue`,
//     `newValue`, `cellValue`, `rowData`, `datum`, `row` and the usual secret
//     names are denied out of the box.
//
//   - Level filtering is a numeric compare against a cached threshold, and the
//     field bag for a suppressed record is never walked. Logging from inside
//     the frame loop has to be free when the level is off.
//
//   - `child(field)` returns a logger with bound context, which is how a
//     per-block or per-plugin logger gets built without threading identifiers
//     through every call.
//
//   - Redaction is depth-bounded and cycle-safe. A grid row can reference its
//     own parent through a tree source; a naive deep walk would hang the tab.
// =============================================================================

import type { GridError, SerializedGridError } from './error';

/** @public */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

/**
 * Numeric severity per level. Exported because adopters bridging to another
 * logging library need the ordering, and re-deriving it invites drift.
 * @public
 */
export const LOG_LEVEL_VALUE: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
});

/** A structured field bag. Values are redacted by name before emission. @public */
export type LogField = Readonly<Record<string, unknown>>;

/** @public */
export interface LogRecord {
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly message: string;
  /** Epoch milliseconds from the injected clock. */
  readonly ts: number;
  /** Already redacted. Safe to ship off-device. */
  readonly field: LogField;
  /** Present when the record was emitted via `logger.reportError`. */
  readonly error?: SerializedGridError | undefined;
}

/** @public */
export interface Logger {
  readonly level: LogLevel;
  readonly trace: (message: string, field?: LogField) => void;
  readonly debug: (message: string, field?: LogField) => void;
  readonly info: (message: string, field?: LogField) => void;
  readonly warn: (message: string, field?: LogField) => void;
  readonly error: (message: string, field?: LogField) => void;
  readonly fatal: (message: string, field?: LogField) => void;
  /** Emit a typed error at `error` level with its code, subsystem and
   *  (redacted) context flattened into the record. */
  readonly reportError: (error: GridError, field?: LogField) => void;
  /** True when a record at `level` would be emitted. Guard expensive field
   *  construction with this rather than building a bag that gets dropped. */
  readonly isEnabled: (level: LogLevel) => boolean;
  /** Derive a logger with permanently bound fields (block index, plugin id). */
  readonly child: (field: LogField) => Logger;
  /** Change the threshold in place. Returns the logger for chaining. */
  readonly setLevel: (level: LogLevel) => Logger;
}

/** @public */
export interface RedactionOption {
  /**
   * Field names to replace with the placeholder, matched case-insensitively at
   * any depth. Supplying this REPLACES the default deny-list; use
   * `additionalField` to extend it instead.
   */
  readonly field?: readonly string[];
  /** Names to deny on top of the defaults. The common way to configure this. */
  readonly additionalField?: readonly string[];
  /** Names to allow through despite matching the deny-list. Explicit opt-out. */
  readonly allowField?: readonly string[];
  /** Substituted for a denied value. Default `'[redacted]'`. */
  readonly placeholder?: string;
  /**
   * Max object depth walked before the subtree is replaced with
   * `'[depth-limit]'`. Default 6. Bounds the cost of logging a deep row.
   */
  readonly maxDepth?: number;
  /** Max array entries kept. Default 32. A 100k-row array in a log is a bug. */
  readonly maxArrayLength?: number;
}

/**
 * Field names redacted unless explicitly allowed. The first block is cell data
 * — the grid's whole payload — and it is denied by default deliberately. The
 * second block is the usual credential vocabulary.
 * @public
 */
export const DEFAULT_REDACTED_FIELD: readonly string[] = Object.freeze([
  'value',
  'oldvalue',
  'newvalue',
  'cellvalue',
  'cell',
  'row',
  'rowdata',
  'datum',
  'data',
  'record',
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'authorization',
  'cookie',
  'ssn',
  'email',
  'phone',
]);

/** @public */
export interface Redactor {
  /** Redact a whole field bag. */
  readonly redact: (field: LogField) => LogField;
  /** True when this exact field name would be redacted. */
  readonly isRedacted: (name: string) => boolean;
}

/**
 * Build a redactor. Cheap to call; the deny-list is compiled into a lowercase
 * Set once and reused for every record.
 * @public
 */
export function createRedactor(option: RedactionOption = {}): Redactor {
  const base = option.field ?? DEFAULT_REDACTED_FIELD;
  const deny = new Set<string>([...base, ...(option.additionalField ?? [])].map(lower));
  for (const allow of option.allowField ?? []) deny.delete(lower(allow));
  const placeholder = option.placeholder ?? '[redacted]';
  const maxDepth = option.maxDepth ?? 6;
  const maxArrayLength = option.maxArrayLength ?? 32;

  const isRedacted = (name: string): boolean => deny.has(lower(name));

  // `seen` is per top-level call, not per redactor: two sibling fields may
  // legitimately reference the same object and both deserve to be rendered.
  const walk = (value: unknown, depth: number, seen: Set<object>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= maxDepth) return '[depth-limit]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const kept = value.slice(0, maxArrayLength).map((v) => walk(v, depth + 1, seen));
        return value.length > maxArrayLength
          ? [...kept, `[+${value.length - maxArrayLength} more]`]
          : kept;
      }
      // Errors, Dates, Maps and the like are not plain records; stringify
      // rather than enumerate, which would emit nothing useful.
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (value instanceof Date) return value.toISOString();
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        out[key] = isRedacted(key) ? placeholder : walk(inner, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };

  return {
    isRedacted,
    redact(field) {
      const seen = new Set<object>();
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(field)) {
        out[key] = isRedacted(key) ? placeholder : walk(value, 1, seen);
      }
      return out;
    },
  };
}

function lower(s: string): string {
  return s.toLowerCase();
}

/** A terminal destination for finished, already-redacted records. @public */
export type LogSink = (record: LogRecord) => void;

/** @public */
export interface LoggerOption {
  /** Minimum level emitted. Default `'info'`. */
  readonly level?: LogLevel;
  /** Redaction configuration. Omitting it still redacts — see `DEFAULT_REDACTED_FIELD`. */
  readonly redaction?: RedactionOption;
  /** Pass a pre-built redactor to share one across loggers. */
  readonly redactor?: Redactor;
  /** Fields merged into every record. Redacted like any other field. */
  readonly baseField?: LogField;
  /** Injectable clock. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Core factory: everything below is a sink plus this. Adopters shipping to
 * their own transport should use this directly rather than wrapping the console
 * logger.
 * @public
 */
export function createLogger(sink: LogSink, option: LoggerOption = {}): Logger {
  const redactor = option.redactor ?? createRedactor(option.redaction ?? {});
  const now = option.now ?? Date.now;
  const baseField = option.baseField ?? {};
  let level: LogLevel = option.level ?? 'info';
  let threshold = LOG_LEVEL_VALUE[level];

  const emit = (
    recordLevel: Exclude<LogLevel, 'silent'>,
    message: string,
    field: LogField | undefined,
    error: SerializedGridError | undefined,
  ): void => {
    if (LOG_LEVEL_VALUE[recordLevel] < threshold) return;
    // Merge first, redact once: a base field with a denied name must be
    // redacted too, and a caller field must not be able to shadow it clean.
    const merged: Record<string, unknown> = { ...baseField, ...(field ?? {}) };
    sink({
      level: recordLevel,
      message,
      ts: now(),
      field: redactor.redact(merged),
      error,
    });
  };

  const logger: Logger = {
    get level() {
      return level;
    },
    trace: (m, f) => emit('trace', m, f, undefined),
    debug: (m, f) => emit('debug', m, f, undefined),
    info: (m, f) => emit('info', m, f, undefined),
    warn: (m, f) => emit('warn', m, f, undefined),
    error: (m, f) => emit('error', m, f, undefined),
    fatal: (m, f) => emit('fatal', m, f, undefined),
    reportError: (err, f) => {
      const wire = err.toJSON();
      // The error's own context is redacted through the same path as any other
      // field, so a cell value stashed in ErrorContext cannot leak here.
      const serialized: SerializedGridError = {
        ...wire,
        context: redactor.redact(wire.context),
      };
      emit('error', err.message, { code: err.code, subsystem: err.subsystem, ...f }, serialized);
    },
    isEnabled: (l) => LOG_LEVEL_VALUE[l] >= threshold && l !== 'silent',
    child: (f) =>
      createLogger(sink, {
        level,
        redactor,
        baseField: { ...baseField, ...f },
        now,
      }),
    setLevel: (l) => {
      level = l;
      threshold = LOG_LEVEL_VALUE[l];
      return logger;
    },
  };
  return logger;
}

/** @public */
export interface ConsoleLike {
  readonly debug: (...arg: readonly unknown[]) => void;
  readonly info: (...arg: readonly unknown[]) => void;
  readonly warn: (...arg: readonly unknown[]) => void;
  readonly error: (...arg: readonly unknown[]) => void;
}

/**
 * Console logger. `trace` and `debug` both go to `console.debug`, `fatal` to
 * `console.error`. The console object is injectable so this is testable without
 * monkey-patching a global.
 * @public
 */
export function createConsoleLogger(
  option: LoggerOption & { readonly console?: ConsoleLike } = {},
): Logger {
  const target: ConsoleLike = option.console ?? globalThis.console;
  return createLogger((record) => {
    const prefix = `[onegrid:${record.level}]`;
    const arg: unknown[] = [prefix, record.message];
    if (Object.keys(record.field).length > 0) arg.push(record.field);
    if (record.error) arg.push(record.error);
    switch (record.level) {
      case 'trace':
      case 'debug':
        target.debug(...arg);
        break;
      case 'info':
        target.info(...arg);
        break;
      case 'warn':
        target.warn(...arg);
        break;
      case 'error':
      case 'fatal':
        target.error(...arg);
        break;
    }
  }, option);
}

/** @public */
export interface MemoryLogger extends Logger {
  /** Every record emitted since the last `clear()`, oldest first. */
  readonly record: () => readonly LogRecord[];
  /** Records at exactly this level. */
  readonly recordAt: (level: LogLevel) => readonly LogRecord[];
  /** True when no emitted record — message, fields, or error — contains
   *  `needle` anywhere in its JSON form. The assertion redaction tests want. */
  readonly isAbsent: (needle: string) => boolean;
  readonly clear: () => void;
}

/**
 * In-memory logger for tests. Keeps a bounded ring of records so a long test
 * run cannot exhaust memory, and exposes `isAbsent` so a redaction test can
 * assert a cell value appears nowhere in the emitted output — including nested
 * inside an error's serialized context, which a naive check would miss.
 * @public
 */
export function createMemoryLogger(
  option: LoggerOption & { readonly capacity?: number } = {},
): MemoryLogger {
  const capacity = option.capacity ?? 1000;
  let buffer: LogRecord[] = [];
  const base = createLogger((r) => {
    buffer.push(r);
    if (buffer.length > capacity) buffer.shift();
  }, option);

  return {
    ...base,
    get level() {
      return base.level;
    },
    record: () => buffer,
    recordAt: (level) => buffer.filter((r) => r.level === level),
    isAbsent: (needle) => !JSON.stringify(buffer).includes(needle),
    clear: () => {
      buffer = [];
    },
  };
}

/** A logger that discards everything. Used as the default wherever a Logger is
 *  optional, so call sites never branch on `logger === undefined`. @public */
export function createNoopLogger(): Logger {
  return createLogger(() => undefined, { level: 'silent' });
}
