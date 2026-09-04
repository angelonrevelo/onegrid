// =============================================================================
// React cell renderer adapter.
//
// Wraps a React component-per-cell into the framework-agnostic
// CellRenderer interface @onegrid/core consumes. Pattern:
//
//   const StatusPill = ({ value }: { value: string }) => (
//     <span className={`pill pill-${value}`}>{value}</span>
//   );
//
//   const renderer = createReactCellRenderer({
//     id: 'status-pill',
//     component: StatusPill,
//   });
//
//   columns: [{ id: 'status', width: 110, renderer }]
//
// Architecture (per docs/v0.0.6.md § 3):
//   - One React root per pooled DOM element. Created on mount, kept
//     alive across scroll-in/scroll-out cycles via the RendererPool.
//   - Props flow through a useSyncExternalStore subscription so the
//     component re-renders when the cell's value changes WITHOUT
//     destroying the React fiber.
//   - reset() unmounts only when the instance is being torn down for
//     real (pool destroy); recycle leaves React state intact.
// =============================================================================

import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createElement, type ComponentType } from 'react';
import type { CellRenderContext, CellRenderer } from '@onegrid/core';

export interface CreateReactCellRendererOptions<P extends CellRenderContext = CellRenderContext> {
  readonly id: string;
  readonly component: ComponentType<P>;
}

interface PerInstance {
  readonly root: Root;
  lastValue: unknown;
  lastRow: number;
  lastCol: string;
}

const PER_INSTANCE = new WeakMap<HTMLElement, PerInstance>();

/**
 * Wrap a React component as a `CellRenderer`. The component receives
 * `{ value, rowIndex, columnId }` as props on every cell change.
 *
 * The React root is created once per pooled element (in `mount`) and
 * survives recycle through the pool, so framework state (component
 * fields, hook state, refs) persists across scroll-in/scroll-out
 * cycles. `update` re-renders the component with new props through
 * the usual React reconciliation path; React itself diffs and only
 * commits actual DOM changes.
 */
function paint(root: Root, element: ReturnType<typeof createElement>): void {
  queueMicrotask(() => {
    flushSync(() => {
      root.render(element);
    });
  });
}

export function createReactCellRenderer<P extends CellRenderContext = CellRenderContext>(
  options: CreateReactCellRendererOptions<P>,
): CellRenderer {
  const { id, component } = options;

  return {
    id,
    mount(ctx) {
      const el = document.createElement('div');
      el.style.cssText = 'width:100%;height:100%;box-sizing:border-box;';

      const root = createRoot(el);
      // createRoot.render is concurrent; WebKit needs a sync commit so
      // the overlay isn't empty. Defer flushSync to a microtask so we
      // never call it inside a React layout effect (playground Grid
      // paints from useLayoutEffect and flushSync would warn).
      paint(root, createElement(component, ctx as P));
      PER_INSTANCE.set(el, {
        root,
        lastValue: ctx.value,
        lastRow: ctx.rowIndex,
        lastCol: ctx.columnId,
      });
      return el;
    },
    update(el, ctx) {
      const inst = PER_INSTANCE.get(el);
      if (!inst) return;
      // Skip the round-trip when nothing changed.
      if (
        inst.lastValue === ctx.value &&
        inst.lastRow === ctx.rowIndex &&
        inst.lastCol === ctx.columnId
      ) {
        return;
      }
      inst.lastValue = ctx.value;
      inst.lastRow = ctx.rowIndex;
      inst.lastCol = ctx.columnId;
      paint(inst.root, createElement(component, ctx as P));
    },
    reset() {
      // Recycle back to the pool. We deliberately do NOT unmount here;
      // the next acquire() will reuse this instance. The DOM element
      // gets display:none from the pool, so the React tree is paused
      // visually but its fiber + state survive.
    },
  };
}

/** Tear-down hook that ACTUALLY unmounts the React root. The grid's
 *  `destroy()` removes pooled elements from the DOM, but React roots
 *  must also be `unmount()`-ed to release their concurrent work. Call
 *  this on every element the grid hands you back during teardown. */
export function unmountReactCell(el: HTMLElement): void {
  const inst = PER_INSTANCE.get(el);
  if (!inst) return;
  inst.root.unmount();
  PER_INSTANCE.delete(el);
}
