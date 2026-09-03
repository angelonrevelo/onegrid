import { describe, expect, it, vi } from 'vitest';
import {
  GRID_OPERATION,
  SPAN_STATUS,
  adaptTracer,
  createMemoryTracer,
  createNoopTracer,
  type OtelLikeTracer,
} from '../index';

describe('OpenTelemetry breadcrumbs', () => {
  it('names a span for every operation worth tracing', () => {
    expect([...GRID_OPERATION]).toEqual([
      'block.fetch',
      'sort',
      'filter',
      'group',
      'pivot',
      'formula.recompute',
      'render.frame',
    ]);
  });

  it('emits a prefixed, attributed span through a supplied tracer', () => {
    const fake = createMemoryTracer();
    const tracer = adaptTracer(fake, { baseAttribute: { 'grid.id': 'orders' } });
    tracer.traceSync('block.fetch', (span) => {
      span.setAttribute('onegrid.block.index', 3);
      span.addEvent('cache.miss');
      return 'rows';
    });
    const span = fake.span[0];
    expect(fake.span).toHaveLength(1);
    expect(span?.name).toBe('onegrid.block.fetch');
    expect(span?.attribute['grid.id']).toBe('orders');
    expect(span?.attribute['onegrid.operation']).toBe('block.fetch');
    expect(span?.attribute['onegrid.block.index']).toBe(3);
    expect(span?.event[0]?.name).toBe('cache.miss');
    expect(span?.status.code).toBe(SPAN_STATUS.OK);
    expect(span?.ended).toBe(true);
  });

  it('traces each grid operation under its own span name', () => {
    const fake = createMemoryTracer();
    const tracer = adaptTracer(fake);
    for (const operation of GRID_OPERATION) tracer.traceSync(operation, () => undefined);
    expect(fake.span.map((s) => s.name)).toEqual([
      'onegrid.block.fetch',
      'onegrid.sort',
      'onegrid.filter',
      'onegrid.group',
      'onegrid.pivot',
      'onegrid.formula.recompute',
      'onegrid.render.frame',
    ]);
  });

  it('records the exception with its taxonomy code, then rethrows', () => {
    const fake = createMemoryTracer();
    const tracer = adaptTracer(fake);
    expect(() =>
      tracer.traceSync('formula.recompute', () => {
        throw new Error('circular reference');
      }),
    ).toThrow('circular reference');
    const span = fake.span[0];
    expect(span?.status.code).toBe(SPAN_STATUS.ERROR);
    expect(span?.attribute['onegrid.error.code']).toBe('OG_FORMULA_EVAL');
    expect(span?.attribute['onegrid.error.subsystem']).toBe('formula');
    expect(span?.attribute['onegrid.error.retryable']).toBe(false);
    expect(span?.exception).toHaveLength(1);
    // Ended even on the throw path — an unended span leaks in every backend.
    expect(span?.ended).toBe(true);
  });

  it('classifies a failing operation into the right subsystem', () => {
    const fake = createMemoryTracer();
    const tracer = adaptTracer(fake);
    for (const operation of ['block.fetch', 'sort', 'render.frame'] as const) {
      try {
        tracer.traceSync(operation, () => {
          throw new Error('x');
        });
      } catch {
        // expected
      }
    }
    expect(fake.span.map((s) => s.attribute['onegrid.error.subsystem'])).toEqual([
      'data',
      'worker',
      'render',
    ]);
  });

  it('ends the async span when the promise settles, not when it starts', async () => {
    const fake = createMemoryTracer();
    const tracer = adaptTracer(fake);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = tracer.traceAsync('block.fetch', async () => {
      await gate;
      return 7;
    });
    expect(fake.span[0]?.ended).toBe(false);
    release();
    expect(await pending).toBe(7);
    expect(fake.span[0]?.ended).toBe(true);
    expect(fake.span[0]?.status.code).toBe(SPAN_STATUS.OK);
  });

  it('records and rethrows an async rejection', async () => {
    const fake = createMemoryTracer();
    const tracer = adaptTracer(fake);
    await expect(
      tracer.traceAsync('block.fetch', () => Promise.reject(new Error('502'))),
    ).rejects.toThrow('502');
    expect(fake.span[0]?.status.code).toBe(SPAN_STATUS.ERROR);
    expect(fake.span[0]?.attribute['onegrid.error.code']).toBe('OG_DATA_BLOCK_FETCH');
  });

  it('no-ops with no tracer, and still runs the body and returns its value', () => {
    const tracer = adaptTracer(undefined);
    expect(tracer.isRecording).toBe(false);
    const body = vi.fn(() => 'result');
    expect(tracer.traceSync('sort', body)).toBe('result');
    expect(body).toHaveBeenCalledTimes(1);
    const span = tracer.startSpan('render.frame');
    expect(span.isRecording).toBe(false);
    // Every span method is chainable and inert.
    expect(span.setAttribute('a', 1).addEvent('e').setStatus(SPAN_STATUS.OK)).toBe(span);
    span.recordError(new Error('ignored'));
    span.end();
  });

  it('the no-op tracer still propagates a throw', () => {
    const tracer = createNoopTracer();
    expect(() =>
      tracer.traceSync('pivot', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('drops undefined attributes, which OTel rejects', () => {
    const fake = createMemoryTracer();
    adaptTracer(fake).traceSync('sort', () => undefined, {
      'grid.dataset': undefined,
      'grid.column.count': 12,
    });
    expect(Object.keys(fake.span[0]?.attribute ?? {})).not.toContain('grid.dataset');
    expect(fake.span[0]?.attribute['grid.column.count']).toBe(12);
  });

  it('accepts any structurally OTel-shaped tracer — no import required', () => {
    // This object is hand-rolled to the shape `@opentelemetry/api` publishes.
    // If it satisfies OtelLikeTracer, so does the real Tracer.
    const call: string[] = [];
    const hand: OtelLikeTracer = {
      startSpan(name) {
        call.push(`start:${name}`);
        return {
          setAttribute: () => undefined,
          addEvent: () => undefined,
          recordException: () => undefined,
          setStatus: () => undefined,
          end: () => call.push('end'),
        };
      },
    };
    adaptTracer(hand).traceSync('group', () => undefined);
    expect(call).toEqual(['start:onegrid.group', 'end']);
  });
});
