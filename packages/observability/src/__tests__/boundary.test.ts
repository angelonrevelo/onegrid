import { describe, expect, it, vi } from 'vitest';
import {
  createErrorBoundary,
  createMemoryLogger,
  createMetricRegistry,
  type BoundaryFailure,
  type GridError,
} from '../index';

describe('error boundary', () => {
  it('absorbs a throw and returns the fallback instead of taking the grid down', () => {
    const boundary = createErrorBoundary<string>({ fallback: () => '#ERR' });
    const value = boundary.runCell({ rowIndex: 3, columnId: 'price' }, () => {
      throw new Error('renderer exploded');
    });
    expect(value).toBe('#ERR');
  });

  it('returns undefined with no fallback configured', () => {
    const boundary = createErrorBoundary();
    expect(
      boundary.run('k', () => {
        throw new Error('nope');
      }),
    ).toBeUndefined();
  });

  it('passes successful values straight through and leaves no error state', () => {
    const boundary = createErrorBoundary<string>({ fallback: () => '#ERR' });
    expect(boundary.runCell({ rowIndex: 1, columnId: 'a' }, () => 'ok')).toBe('ok');
    expect(boundary.errorState()).toHaveLength(0);
  });

  it('isolates per cell — a broken cell does not mark its neighbours', () => {
    const boundary = createErrorBoundary<string>({ fallback: () => '#ERR' });
    boundary.runCell({ rowIndex: 5, columnId: 'total' }, () => {
      throw new Error('bad value');
    });
    const failure = boundary.failureAt({ rowIndex: 5, columnId: 'total' });
    expect(failure?.rowIndex).toBe(5);
    expect(failure?.columnId).toBe('total');
    expect(failure?.error.subsystem).toBe('render');
    // The cell next door is untouched, which is what "isolate" has to mean.
    expect(boundary.failureAt({ rowIndex: 5, columnId: 'qty' })).toBeUndefined();
    expect(boundary.failureAt({ rowIndex: 6, columnId: 'total' })).toBeUndefined();
    expect(boundary.errorState()).toHaveLength(1);
  });

  it('widens containment to the whole column when isolate is "column"', () => {
    const boundary = createErrorBoundary({ isolate: 'column' });
    boundary.runCell({ rowIndex: 1, columnId: 'total' }, () => {
      throw new Error('formatter broken');
    });
    boundary.runCell({ rowIndex: 2, columnId: 'total' }, () => {
      throw new Error('formatter broken');
    });
    // Both rows landed on one record rather than accumulating per cell.
    expect(boundary.errorState()).toHaveLength(1);
    expect(boundary.failureCount('col:total')).toBe(2);
  });

  it('keys by scope', () => {
    const cell = { rowIndex: 4, columnId: 'sku' };
    expect(createErrorBoundary({ isolate: 'cell' }).keyFor(cell)).toBe('4:sku');
    expect(createErrorBoundary({ isolate: 'row' }).keyFor(cell)).toBe('row:4');
    expect(createErrorBoundary({ isolate: 'column' }).keyFor(cell)).toBe('col:sku');
    expect(createErrorBoundary({ isolate: 'subsystem', subsystem: 'gpu' }).keyFor(cell)).toBe(
      'sub:gpu',
    );
    expect(createErrorBoundary({ isolate: 'global' }).keyFor(cell)).toBe('*');
  });

  it('calls onError once per real failure with the failure record', () => {
    const seen: BoundaryFailure[] = [];
    const boundary = createErrorBoundary({
      onError: (_error: GridError, failure) => seen.push(failure),
      failureThreshold: 0,
    });
    for (let i = 0; i < 3; i++) {
      boundary.runCell({ rowIndex: 0, columnId: 'a' }, () => {
        throw new Error('x');
      });
    }
    expect(seen).toHaveLength(3);
    expect(seen.map((f) => f.failureCount)).toEqual([1, 2, 3]);
    expect(seen[0]?.key).toBe('0:a');
  });

  it('resets the consecutive count on success — a one-off failure is not a break', () => {
    const boundary = createErrorBoundary({ failureThreshold: 3 });
    const cell = { rowIndex: 0, columnId: 'a' };
    boundary.runCell(cell, () => {
      throw new Error('blip');
    });
    boundary.runCell(cell, () => {
      throw new Error('blip');
    });
    expect(boundary.failureCount('0:a')).toBe(2);
    boundary.runCell(cell, () => 'fine');
    expect(boundary.failureCount('0:a')).toBe(0);
    expect(boundary.isTripped('0:a')).toBe(false);
    expect(boundary.failureAt(cell)).toBeUndefined();
  });

  describe('circuit breaker', () => {
    it('stops calling a renderer that has thrown N times', () => {
      const render = vi.fn(() => {
        throw new Error('always broken');
      });
      const boundary = createErrorBoundary<string>({
        failureThreshold: 3,
        fallback: () => '#ERR',
      });
      const guarded = boundary.guardCellRenderer(render);
      const cell = { rowIndex: 0, columnId: 'broken' };

      // Sixty frames of a broken cell. Without the breaker that is sixty calls
      // and sixty stack captures inside the frame loop.
      for (let frame = 0; frame < 60; frame++) expect(guarded(cell)).toBe('#ERR');

      expect(render).toHaveBeenCalledTimes(3);
      expect(boundary.isTripped('0:broken')).toBe(true);
      expect(boundary.stateOf('0:broken')).toBe('open');
      const failure = boundary.failureAt(cell);
      expect(failure?.failureCount).toBe(3);
      expect(failure?.skippedCount).toBe(57);
    });

    it('does not spam onError once open', () => {
      const onError = vi.fn();
      const boundary = createErrorBoundary({ failureThreshold: 2, onError });
      for (let i = 0; i < 20; i++) {
        boundary.run('k', () => {
          throw new Error('x');
        });
      }
      expect(onError).toHaveBeenCalledTimes(2);
    });

    it('goes half-open after the cooldown and allows exactly one probe', () => {
      let clock = 1000;
      const body = vi.fn(() => {
        throw new Error('still broken');
      });
      const boundary = createErrorBoundary({
        failureThreshold: 2,
        resetAfterMs: 5000,
        now: () => clock,
      });

      boundary.run('k', body);
      boundary.run('k', body);
      expect(boundary.stateOf('k')).toBe('open');

      // Short of the cooldown: still skipped.
      clock += 4999;
      boundary.run('k', body);
      expect(body).toHaveBeenCalledTimes(2);

      // Past it: half-open, one probe allowed.
      clock += 1;
      expect(boundary.stateOf('k')).toBe('half-open');
      boundary.run('k', body);
      expect(body).toHaveBeenCalledTimes(3);
      // The probe failed, so it re-opens and the cooldown restarts.
      expect(boundary.stateOf('k')).toBe('open');
      boundary.run('k', body);
      expect(body).toHaveBeenCalledTimes(3);
    });

    it('closes for good when the half-open probe succeeds', () => {
      let clock = 0;
      let broken = true;
      const boundary = createErrorBoundary<string>({
        failureThreshold: 2,
        resetAfterMs: 100,
        now: () => clock,
      });
      const body = (): string => {
        if (broken) throw new Error('transient');
        return 'healed';
      };
      boundary.run('k', body);
      boundary.run('k', body);
      expect(boundary.isTripped('k')).toBe(true);

      broken = false;
      clock += 100;
      expect(boundary.run('k', body)).toBe('healed');
      expect(boundary.stateOf('k')).toBe('closed');
      expect(boundary.failureCount('k')).toBe(0);
    });

    it('never opens when the threshold is 0', () => {
      const body = vi.fn(() => {
        throw new Error('x');
      });
      const boundary = createErrorBoundary({ failureThreshold: 0 });
      for (let i = 0; i < 10; i++) boundary.run('k', body);
      expect(body).toHaveBeenCalledTimes(10);
      expect(boundary.isTripped('k')).toBe(false);
    });

    it('stays open forever when resetAfterMs is 0, until reset explicitly', () => {
      let clock = 0;
      const boundary = createErrorBoundary({ failureThreshold: 1, resetAfterMs: 0, now: () => clock });
      boundary.run('k', () => {
        throw new Error('x');
      });
      clock += 1_000_000;
      expect(boundary.stateOf('k')).toBe('open');
      boundary.reset('k');
      expect(boundary.stateOf('k')).toBe('closed');
    });

    it('reset() with no key clears every record', () => {
      const boundary = createErrorBoundary({ failureThreshold: 1 });
      boundary.run('a', () => {
        throw new Error('x');
      });
      boundary.run('b', () => {
        throw new Error('x');
      });
      expect(boundary.errorState()).toHaveLength(2);
      boundary.reset();
      expect(boundary.errorState()).toHaveLength(0);
    });
  });

  it('bounds tracked keys so a 100M-row grid cannot leak', () => {
    const boundary = createErrorBoundary({ maxTrackedKey: 10, failureThreshold: 1 });
    for (let rowIndex = 0; rowIndex < 100; rowIndex++) {
      boundary.runCell({ rowIndex, columnId: 'a' }, () => {
        throw new Error('x');
      });
    }
    expect(boundary.errorState()).toHaveLength(10);
    // Oldest evicted first, so the newest failures are the ones retained.
    expect(boundary.failureAt({ rowIndex: 99, columnId: 'a' })).toBeDefined();
    expect(boundary.failureAt({ rowIndex: 0, columnId: 'a' })).toBeUndefined();
  });

  it('treats a rejected promise exactly like a synchronous throw', async () => {
    const boundary = createErrorBoundary<string>({
      subsystem: 'data',
      failureThreshold: 2,
      fallback: () => 'EMPTY_BLOCK',
    });
    const fetchBlock = async (): Promise<string> => {
      await Promise.resolve();
      throw new Error('502 from /block');
    };
    expect(await boundary.runAsync('block:3', fetchBlock)).toBe('EMPTY_BLOCK');
    expect(await boundary.runAsync('block:3', fetchBlock)).toBe('EMPTY_BLOCK');
    expect(boundary.isTripped('block:3')).toBe(true);
    expect(boundary.failure('block:3')?.error.subsystem).toBe('data');

    const good = await boundary.runAsync('block:4', () => Promise.resolve('rows'));
    expect(good).toBe('rows');
  });

  it('guard() keeps the wrapped function signature', () => {
    const boundary = createErrorBoundary<number>({ fallback: () => -1 });
    const parse = boundary.guard(
      (raw: string) => `parse:${raw}`,
      (raw: string) => {
        const n = Number(raw);
        if (Number.isNaN(n)) throw new Error(`not a number: ${raw}`);
        return n;
      },
    );
    expect(parse('42')).toBe(42);
    expect(parse('abc')).toBe(-1);
  });

  it('reports every failure through the logger and counts it in metrics', () => {
    const logger = createMemoryLogger({ level: 'trace' });
    const metric = createMetricRegistry();
    const boundary = createErrorBoundary({
      logger,
      metric,
      subsystem: 'plugin',
      failureThreshold: 2,
    });
    for (let i = 0; i < 5; i++) {
      boundary.run('plugin:acme', () => {
        throw new Error('hook threw');
      });
    }
    expect(logger.recordAt('error')).toHaveLength(2);
    expect(logger.record()[0]?.error?.subsystem).toBe('plugin');
    expect(metric.getCounter('onegrid.boundary.plugin.failure')).toBe(2);
    expect(metric.getCounter('onegrid.boundary.plugin.trip')).toBe(1);
    expect(metric.getCounter('onegrid.boundary.plugin.skip')).toBe(3);
  });

  it('classifies untyped throws into the boundary subsystem and keeps typed ones', () => {
    const boundary = createErrorBoundary({ subsystem: 'gpu' });
    boundary.run('device', () => {
      throw new Error('device lost: driver reset');
    });
    const failure = boundary.failure('device');
    expect(failure?.error.subsystem).toBe('gpu');
    expect(failure?.error.code).toBe('OG_GPU_DEVICE_LOST');
    expect(failure?.error.context['boundaryKey']).toBe('device');
  });
});
