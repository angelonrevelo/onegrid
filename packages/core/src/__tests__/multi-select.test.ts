import { describe, expect, it } from 'vitest';
import {
  createMultiSelectEditor,
  filterOption,
  formatMultiValue,
  layoutChip,
  MULTI_VALUE_DELIMITER,
  parseMultiValue,
  toggleValue,
} from '../editing/multi-select';
import type { CellEditContext } from '../types';

const measure = (text: string): number => text.length * 10;

const option = [
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
];

const context = (value: unknown): CellEditContext => ({
  value,
  rowIndex: 0,
  columnId: 'tag',
  displayText: String(value ?? ''),
});

describe('formatMultiValue / parseMultiValue', () => {
  it('round-trips a simple list', () => {
    expect(parseMultiValue(formatMultiValue(['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
  });

  it('returns empty for null, undefined and empty string', () => {
    expect(parseMultiValue(null)).toEqual([]);
    expect(parseMultiValue(undefined)).toEqual([]);
    expect(parseMultiValue('')).toEqual([]);
  });

  it('passes an array through', () => {
    expect(parseMultiValue(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('escapes a value containing the delimiter rather than splitting it', () => {
    const value = ['a|b', 'c'];
    const encoded = formatMultiValue(value);

    expect(encoded).toBe('a\\|b|c');
    // The whole point: a legitimate pipe in the data survives the round trip.
    expect(parseMultiValue(encoded)).toEqual(['a|b', 'c']);
  });

  it('escapes a literal backslash', () => {
    const value = ['a\\b', 'c'];
    expect(parseMultiValue(formatMultiValue(value))).toEqual(value);
  });

  it('round-trips a value that is only delimiters', () => {
    const value = ['|||'];
    expect(parseMultiValue(formatMultiValue(value))).toEqual(value);
  });

  it('honours a custom delimiter', () => {
    const encoded = formatMultiValue(['a', 'b'], ',');
    expect(encoded).toBe('a,b');
    expect(parseMultiValue(encoded, ',')).toEqual(['a', 'b']);
  });

  it('treats a trailing lone backslash as data', () => {
    expect(parseMultiValue('a\\')).toEqual(['a\\']);
  });

  it('uses a pipe by default', () => {
    expect(MULTI_VALUE_DELIMITER).toBe('|');
  });
});

describe('layoutChip', () => {
  it('lays every chip out when they all fit', () => {
    const result = layoutChip(['ab', 'cd'], { width: 500, measure });

    expect(result.overflowCount).toBe(0);
    expect(result.chip).toHaveLength(2);
    expect(result.chip[0]).toEqual({ text: 'ab', x: 0, width: 32 });
    // 32 wide + 4 gap.
    expect(result.chip[1]?.x).toBe(36);
  });

  it('reports an overflow badge when chips do not fit', () => {
    const result = layoutChip(['aaaa', 'bbbb', 'cccc', 'dddd'], {
      width: 120,
      measure,
    });

    expect(result.overflowCount).toBeGreaterThan(0);
    expect(result.overflow).toBeDefined();
    expect(result.chip.length + result.overflowCount).toBe(4);
  });

  it('never lets a chip run past the available width', () => {
    const result = layoutChip(['aaaa', 'bbbb', 'cccc', 'dddd'], {
      width: 120,
      measure,
    });
    for (const chip of result.chip) {
      expect(chip.x + chip.width).toBeLessThanOrEqual(120);
    }
  });

  it('handles an empty value list', () => {
    const result = layoutChip([], { width: 100, measure });
    expect(result.chip).toEqual([]);
    expect(result.overflowCount).toBe(0);
  });

  it('reports every chip as overflow when not even one fits', () => {
    const result = layoutChip(['aaaaaaaaaa', 'b'], { width: 20, measure });
    expect(result.chip).toHaveLength(0);
    expect(result.overflowCount).toBe(2);
  });
});

describe('filterOption', () => {
  it('returns everything for an empty query', () => {
    expect(filterOption(option, '')).toHaveLength(3);
    expect(filterOption(option, '   ')).toHaveLength(3);
  });

  it('matches value or label, case-insensitively', () => {
    expect(filterOption(option, 'RE').map((o) => o.value)).toEqual(['red', 'green']);
    expect(filterOption(option, 'blu').map((o) => o.value)).toEqual(['blue']);
  });

  it('returns empty when nothing matches', () => {
    expect(filterOption(option, 'zzz')).toEqual([]);
  });
});

describe('toggleValue', () => {
  it('adds an absent value and removes a present one', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('refuses to add past maxSelected but still allows removal', () => {
    expect(toggleValue(['a', 'b'], 'c', 2)).toEqual(['a', 'b']);
    expect(toggleValue(['a', 'b'], 'b', 2)).toEqual(['a']);
  });

  it('does not mutate its input', () => {
    const input = ['a'];
    toggleValue(input, 'b');
    expect(input).toEqual(['a']);
  });
});

describe('createMultiSelectEditor', () => {
  it('seeds the selection from the cell value', () => {
    const editor = createMultiSelectEditor({ options: option });
    const instance = editor.mount(context('red|blue'));

    expect(instance.getValue()).toBe('red|blue');
    expect(instance.element.querySelectorAll('[data-chip]')).toHaveLength(2);
  });

  it('starts empty for an empty cell', () => {
    const editor = createMultiSelectEditor({ options: option });
    expect(editor.mount(context('')).getValue()).toBe('');
  });

  it('renders one option row per option, marked selected', () => {
    const editor = createMultiSelectEditor({ options: option });
    const instance = editor.mount(context('red'));

    const row = instance.element.querySelectorAll('[role="option"]');
    expect(row).toHaveLength(3);
    expect(row[0]?.getAttribute('aria-selected')).toBe('true');
    expect(row[1]?.getAttribute('aria-selected')).toBe('false');
  });

  it('toggles a value when its option row is pressed', () => {
    const editor = createMultiSelectEditor({ options: option });
    const instance = editor.mount(context('red'));

    const green = instance.element.querySelector('[data-value="green"]');
    green?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(instance.getValue()).toBe('red|green');
  });

  it('removes a chip through its remove button', () => {
    const editor = createMultiSelectEditor({ options: option });
    const instance = editor.mount(context('red|blue'));

    const remove = instance.element.querySelector<HTMLButtonElement>(
      '[data-chip="red"] button',
    );
    remove?.click();

    expect(instance.getValue()).toBe('blue');
  });

  it('honours maxSelected', () => {
    const editor = createMultiSelectEditor({ options: option, maxSelected: 1 });
    const instance = editor.mount(context('red'));

    instance.element
      .querySelector('[data-value="green"]')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(instance.getValue()).toBe('red');
  });

  it('carries the combobox and listbox roles for assistive tech', () => {
    const editor = createMultiSelectEditor({ options: option });
    const instance = editor.mount(context(''));

    expect(instance.element.getAttribute('role')).toBe('combobox');
    expect(
      instance.element.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable'),
    ).toBe('true');
  });

  it('uses the supplied id, or a sensible default', () => {
    expect(createMultiSelectEditor({ options: option }).id).toBe('multi-select');
    expect(createMultiSelectEditor({ options: option, id: 'tag' }).id).toBe('tag');
  });
});
