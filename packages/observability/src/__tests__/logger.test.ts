import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REDACTED_FIELD,
  DataFetchError,
  RenderError,
  createConsoleLogger,
  createLogger,
  createMemoryLogger,
  createNoopLogger,
  createRedactor,
  type LogRecord,
} from '../index';

describe('structured logging', () => {
  it('filters by level', () => {
    const logger = createMemoryLogger({ level: 'warn' });
    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');
    expect(logger.record().map((r) => r.level)).toEqual(['warn', 'error', 'fatal']);
  });

  it('isEnabled answers without building a field bag', () => {
    const logger = createMemoryLogger({ level: 'info' });
    expect(logger.isEnabled('debug')).toBe(false);
    expect(logger.isEnabled('info')).toBe(true);
    expect(logger.isEnabled('error')).toBe(true);
    logger.setLevel('silent');
    expect(logger.isEnabled('fatal')).toBe(false);
  });

  it('setLevel changes the threshold in place', () => {
    const logger = createMemoryLogger({ level: 'error' });
    logger.info('dropped');
    logger.setLevel('debug');
    logger.info('kept');
    expect(logger.record()).toHaveLength(1);
    expect(logger.record()[0]?.message).toBe('kept');
  });

  it('stamps records with the injected clock', () => {
    const logger = createMemoryLogger({ level: 'trace', now: () => 42 });
    logger.info('x');
    expect(logger.record()[0]?.ts).toBe(42);
  });

  it('child loggers bind fields without touching the parent', () => {
    const logger = createMemoryLogger({ level: 'trace' });
    const child = logger.child({ blockIndex: 7 });
    child.info('fetching');
    expect(logger.record()[0]?.field['blockIndex']).toBe(7);
    logger.info('parent');
    expect(logger.record()[1]?.field['blockIndex']).toBeUndefined();
  });

  describe('redaction (on by default)', () => {
    it('a cell value NEVER reaches the sink', () => {
      const logger = createMemoryLogger({ level: 'trace' });
      logger.error('cell render failed', {
        rowIndex: 12,
        columnId: 'salary',
        value: 'Ada Lovelace — 184000 GBP',
      });
      // The assertion that matters: the customer datum appears nowhere in the
      // emitted output, at any nesting depth.
      expect(logger.isAbsent('Ada Lovelace')).toBe(true);
      expect(logger.isAbsent('184000')).toBe(true);
      const record = logger.record()[0] as LogRecord;
      expect(record.field['value']).toBe('[redacted]');
      // The addressing that makes the report actionable survives.
      expect(record.field['rowIndex']).toBe(12);
      expect(record.field['columnId']).toBe('salary');
    });

    it('redacts a cell value nested inside an error context too', () => {
      const logger = createMemoryLogger({ level: 'trace' });
      logger.reportError(
        new RenderError('formatter threw', {
          context: { rowIndex: 3, columnId: 'email', value: 'ada@example.com' },
        }),
      );
      expect(logger.isAbsent('ada@example.com')).toBe(true);
      expect(logger.record()[0]?.error?.context['value']).toBe('[redacted]');
      expect(logger.record()[0]?.error?.code).toBe('OG_RENDER_CELL');
    });

    it('redacts deeply nested and array-held values', () => {
      const logger = createMemoryLogger({ level: 'trace' });
      logger.info('paste', {
        payload: { clipboard: { row: [{ value: 'SECRET-1' }], rowData: 'SECRET-2' } },
      });
      expect(logger.isAbsent('SECRET-1')).toBe(true);
      expect(logger.isAbsent('SECRET-2')).toBe(true);
    });

    it('matches field names case-insensitively', () => {
      const redactor = createRedactor();
      const out = redactor.redact({ CellValue: 'x', OLDVALUE: 'y', apiKey: 'z' });
      expect(out['CellValue']).toBe('[redacted]');
      expect(out['OLDVALUE']).toBe('[redacted]');
      expect(out['apiKey']).toBe('[redacted]');
    });

    it('denies cell data AND credentials out of the box', () => {
      for (const name of ['value', 'cellvalue', 'rowdata', 'password', 'token', 'authorization']) {
        expect(DEFAULT_REDACTED_FIELD).toContain(name);
      }
      const redactor = createRedactor();
      expect(redactor.isRedacted('newValue')).toBe(true);
      expect(redactor.isRedacted('rowIndex')).toBe(false);
    });

    it('opting a field back in is explicit and per-logger', () => {
      const logger = createMemoryLogger({
        level: 'trace',
        redaction: { allowField: ['value'] },
      });
      logger.info('debug dump', { value: 'visible-on-purpose', password: 'still-hidden' });
      expect(logger.record()[0]?.field['value']).toBe('visible-on-purpose');
      expect(logger.record()[0]?.field['password']).toBe('[redacted]');
    });

    it('additionalField extends rather than replaces the defaults', () => {
      const redactor = createRedactor({ additionalField: ['tenantId'] });
      expect(redactor.isRedacted('tenantId')).toBe(true);
      expect(redactor.isRedacted('value')).toBe(true);
    });

    it('a caller field cannot shadow a bound base field past redaction', () => {
      const logger = createMemoryLogger({ level: 'trace', baseField: { value: 'base' } });
      logger.info('x', { value: 'caller' });
      expect(logger.record()[0]?.field['value']).toBe('[redacted]');
    });

    it('survives a cycle instead of hanging the tab', () => {
      const node: Record<string, unknown> = { id: 'root' };
      node['parent'] = node;
      const logger = createMemoryLogger({ level: 'trace' });
      logger.info('tree', { node });
      expect(JSON.stringify(logger.record())).toContain('[circular]');
    });

    it('bounds depth and array length', () => {
      const logger = createMemoryLogger({
        level: 'trace',
        redaction: { maxDepth: 2, maxArrayLength: 3 },
      });
      logger.info('deep', { a: { b: { c: { d: 'too far' } } }, list: [1, 2, 3, 4, 5] });
      const field = logger.record()[0]?.field ?? {};
      expect(JSON.stringify(field)).toContain('[depth-limit]');
      expect(JSON.stringify(field)).toContain('[+2 more]');
      expect(logger.isAbsent('too far')).toBe(true);
    });

    it('renders Errors and Dates rather than enumerating them to nothing', () => {
      const logger = createMemoryLogger({ level: 'trace' });
      logger.info('x', { cause: new TypeError('bad call'), at: new Date(0) });
      expect(logger.record()[0]?.field['cause']).toBe('TypeError: bad call');
      expect(logger.record()[0]?.field['at']).toBe('1970-01-01T00:00:00.000Z');
    });
  });

  it('reportError flattens the code and subsystem onto the record', () => {
    const logger = createMemoryLogger({ level: 'trace' });
    logger.reportError(
      new DataFetchError('block timed out', { code: 'OG_DATA_BLOCK_TIMEOUT' }),
      { blockIndex: 4 },
    );
    const record = logger.record()[0] as LogRecord;
    expect(record.level).toBe('error');
    expect(record.field['code']).toBe('OG_DATA_BLOCK_TIMEOUT');
    expect(record.field['subsystem']).toBe('data');
    expect(record.field['blockIndex']).toBe(4);
    expect(record.error?.retryable).toBe(true);
  });

  it('the console logger routes each level to the right console method', () => {
    const fake = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const logger = createConsoleLogger({ level: 'trace', console: fake });
    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');
    expect(fake.debug).toHaveBeenCalledTimes(2);
    expect(fake.info).toHaveBeenCalledTimes(1);
    expect(fake.warn).toHaveBeenCalledTimes(1);
    expect(fake.error).toHaveBeenCalledTimes(2);
    expect(fake.info.mock.calls[0]?.[0]).toBe('[onegrid:info]');
  });

  it('the console logger redacts before it prints', () => {
    const fake = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    createConsoleLogger({ console: fake }).info('edit', { newValue: 'PII-HERE' });
    expect(JSON.stringify(fake.info.mock.calls)).not.toContain('PII-HERE');
  });

  it('the memory logger keeps a bounded ring', () => {
    const logger = createMemoryLogger({ level: 'trace', capacity: 3 });
    for (let i = 0; i < 10; i++) logger.info(`m${i}`);
    expect(logger.record()).toHaveLength(3);
    expect(logger.record()[0]?.message).toBe('m7');
    logger.clear();
    expect(logger.record()).toHaveLength(0);
  });

  it('the noop logger emits nothing and costs nothing', () => {
    const sink = vi.fn();
    createNoopLogger().error('should vanish');
    expect(sink).not.toHaveBeenCalled();
    // And a custom logger at silent likewise never reaches its sink.
    createLogger(sink, { level: 'silent' }).fatal('nor this');
    expect(sink).not.toHaveBeenCalled();
  });
});
