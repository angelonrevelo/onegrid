import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  defineGridOptions,
  editingPreset,
  mobilePreset,
  enterprisePreset,
  accessibilityPreset,
  type NestedGridOptions,
} from '../options.js';
import { __resetDeprecationWarningsForTests } from '../options.js';
import type { GridOptions } from '../types.js';

function fakeHost(): HTMLElement {
  return { tagName: 'DIV' } as unknown as HTMLElement;
}

const baseData = {
  rowSource: { readBlock: () => ({ rows: [], totalRowCount: 0 }) } as unknown as GridOptions['rowSource'],
  columns: [{ id: 'a', width: 100 }] as unknown as GridOptions['columns'],
  rowHeight: 32,
};

describe('defineGridOptions — nested form', () => {
  beforeEach(() => __resetDeprecationWarningsForTests());

  it('flattens nested input to the canonical GridOptions shape', () => {
    const opts: NestedGridOptions = {
      host: fakeHost(),
      data: baseData,
      columns: { frozenCount: 2, enableReorder: true },
      editing: { enableFillHandle: true },
      grouping: { stickyGroupRows: false },
    };
    const flat = defineGridOptions(opts);
    expect(flat.frozenColumnCount).toBe(2);
    expect(flat.enableColumnReorder).toBe(true);
    expect(flat.enableFillHandle).toBe(true);
    expect(flat.stickyGroupRows).toBe(false);
  });

  it('rejects unknown namespaces with OG_OPT_UNKNOWN_NAMESPACE', () => {
    const bad = {
      host: fakeHost(),
      data: baseData,
      bogus: {},
    };
    expect(() => defineGridOptions(bad as unknown as NestedGridOptions)).toThrow(
      /OG_OPT_UNKNOWN_NAMESPACE/,
    );
  });
});

describe('defineGridOptions — flat form deprecation', () => {
  beforeEach(() => __resetDeprecationWarningsForTests());

  it('warns once per flat field with [OG_DEPRECATED_FLAT_OPT]', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const flat: GridOptions = {
      host: fakeHost(),
      ...baseData,
      enableColumnReorder: true,
      enableFillHandle: true,
      onFillHandle: () => {},
    } as GridOptions;
    defineGridOptions(flat);
    defineGridOptions(flat);
    const warnings = spy.mock.calls.flat().filter((s) =>
      String(s).includes('OG_DEPRECATED_FLAT_OPT'),
    );
    // Each unique field warns once total, even across multiple calls.
    const fields = new Set(warnings.map((w) => String(w).match(/'([^']+)'/)?.[1]));
    expect(fields.has('enableColumnReorder')).toBe(true);
    expect(fields.has('enableFillHandle')).toBe(true);
    expect(warnings).toHaveLength(fields.size);
    spy.mockRestore();
  });
});

describe('Validation error codes', () => {
  beforeEach(() => __resetDeprecationWarningsForTests());

  it('defaults omitted rowHeight to DEFAULT_ROW_HEIGHT', () => {
    const flat = defineGridOptions({
      host: fakeHost(),
      data: {
        rowSource: baseData.rowSource,
        columns: baseData.columns,
      },
    });
    expect(flat.rowHeight).toBe(32);
  });

  it('OG_INVALID_OPTION when rowHeight is non-positive', () => {
    expect(() =>
      defineGridOptions({
        host: fakeHost(),
        data: { ...baseData, rowHeight: 0 },
      } as NestedGridOptions),
    ).toThrow(/OG_INVALID_OPTION/);
  });

  it('OG_OPT_REQUIRES when onFillHandle set without enableFillHandle', () => {
    expect(() =>
      defineGridOptions({
        host: fakeHost(),
        data: baseData,
        editing: { onFillHandle: () => {} },
      } as NestedGridOptions),
    ).toThrow(/OG_OPT_REQUIRES/);
  });

  it('OG_I18N_INVALID_LOCALE on bad BCP 47 tag', () => {
    expect(() =>
      defineGridOptions({
        host: fakeHost(),
        data: baseData,
        i18n: { locale: '!!nope' },
      } as NestedGridOptions),
    ).toThrow(/OG_I18N_INVALID_LOCALE/);
  });

  it('accepts valid BCP 47 locales', () => {
    const opts = defineGridOptions({
      host: fakeHost(),
      data: baseData,
      i18n: { locale: 'en-US' },
    } as NestedGridOptions);
    expect(opts).toBeDefined();
  });
});

describe('Preset helpers', () => {
  beforeEach(() => __resetDeprecationWarningsForTests());

  it('editingPreset enables fill handle + column reorder', () => {
    const opts = defineGridOptions({
      host: fakeHost(),
      data: baseData,
      ...editingPreset(),
    });
    expect(opts.enableFillHandle).toBe(true);
    expect(opts.enableColumnReorder).toBe(true);
  });

  it('mobilePreset, enterprisePreset, accessibilityPreset all compose via spread', () => {
    expect(mobilePreset().touch?.longPressAction).toBe('context-menu');
    expect(enterprisePreset().grouping?.stickyGroupRows).toBe(true);
    expect(accessibilityPreset().a11y).toBeDefined();
  });
});
