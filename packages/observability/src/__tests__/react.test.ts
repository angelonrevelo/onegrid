import { describe, expect, it, vi } from 'vitest';
import {
  DataFetchError,
  createMemoryLogger,
  createMetricRegistry,
  toReactErrorBoundaryProp,
  type GridError,
} from '../index';

describe('React error-boundary integration', () => {
  it('produces the prop shape react-error-boundary expects', () => {
    const prop = toReactErrorBoundaryProp();
    expect(typeof prop.onError).toBe('function');
    expect(typeof prop.onReset).toBe('function');
  });

  it('classifies a render throw and stashes the component stack in context', () => {
    const seen: GridError[] = [];
    const logger = createMemoryLogger({ level: 'trace' });
    const metric = createMetricRegistry();
    const prop = toReactErrorBoundaryProp({
      logger,
      metric,
      onError: (error) => seen.push(error),
      context: { gridId: 'orders' },
    });

    prop.onError(new TypeError('Cannot read properties of undefined'), {
      componentStack: '\n at Cell\n at Row\n at Grid',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.subsystem).toBe('render');
    expect(seen[0]?.code).toBe('OG_RENDER_CELL');
    expect(seen[0]?.context['reactComponentStack']).toContain('at Grid');
    expect(seen[0]?.context['gridId']).toBe('orders');
    expect(logger.recordAt('error')).toHaveLength(1);
    expect(metric.getCounter('onegrid.react.boundary.failure')).toBe(1);
  });

  it('keeps the classification of an already-typed error', () => {
    const seen: GridError[] = [];
    const prop = toReactErrorBoundaryProp({ onError: (error) => seen.push(error) });
    prop.onError(new DataFetchError('block 3 failed', { code: 'OG_DATA_BLOCK_TIMEOUT' }), {
      componentStack: null,
    });
    expect(seen[0]?.code).toBe('OG_DATA_BLOCK_TIMEOUT');
    expect(seen[0]?.subsystem).toBe('data');
  });

  it('forwards onReset so the host can clear per-cell error state', () => {
    const onReset = vi.fn();
    const metric = createMetricRegistry();
    toReactErrorBoundaryProp({ onReset, metric }).onReset();
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(metric.getCounter('onegrid.react.boundary.reset')).toBe(1);
  });
});
