// =============================================================================
// Multi-select cell type — chips + a popover editor
//
// A multi-value column (tags, labels, assignees, categories) rendered as chips
// per cell, edited through a popover with search, keyboard selection, and
// optional free-text entry. Composes onto the existing editor pipeline the same
// way `createSelectEditor` does: the grid owns positioning, focus, commit and
// validation; this owns the widget.
//
// Design decisions, and why:
//
//   1. THE COMMITTED VALUE IS A STRING, BECAUSE THE PIPELINE COMMITS STRINGS.
//      `CellEditorInstance.getValue()` returns a string and `onCellEdit`
//      receives one. Rather than widen that contract for one editor, values are
//      serialised with a documented, configurable delimiter and a matching
//      `parseMultiValue` is exported so adopters round-trip the same way the
//      editor does. A value containing the delimiter is escaped, not silently
//      split — that is the bug this design exists to avoid.
//
//   2. CHIP LAYOUT IS COMPUTED, NOT GUESSED. The renderer draws to canvas, so
//      it needs to know how many chips fit and where the "+3" overflow badge
//      goes before it paints. `layoutChip` does that arithmetic against an
//      injected measure function, so it is testable without a canvas and it
//      matches what is painted exactly.
//
//   3. THE POPOVER IS KEYBOARD-COMPLETE. Type to filter, Up/Down to move,
//      Enter to toggle, Backspace on an empty query to remove the last chip,
//      Escape to close. A picker reachable only by mouse fails the grid's own
//      accessibility gate, and the backspace-removes-last-chip behaviour is
//      what every tag input does.
// =============================================================================

import type { CellEditContext, CellEditor, CellEditorInstance } from '../types';

/** @public */
export interface MultiSelectOption {
  readonly value: string;
  readonly label?: string;
  /** Chip background; the renderer may ignore it. */
  readonly color?: string;
}

/** Default separator. Chosen because it is rare in real tag text and survives
 *  CSV/TSV round-trips, unlike a tab or a newline. @public */
export const MULTI_VALUE_DELIMITER = '|';

const escapeValue = (value: string, delimiter: string): string =>
  value.split('\\').join('\\\\').split(delimiter).join(`\\${delimiter}`);

/**
 * Serialise selected values into the single string the edit pipeline commits.
 * @public
 */
export function formatMultiValue(
  value: ReadonlyArray<string>,
  delimiter: string = MULTI_VALUE_DELIMITER,
): string {
  return value.map((v) => escapeValue(v, delimiter)).join(delimiter);
}

/**
 * Parse a committed string back into values, honouring backslash escapes so a
 * value legitimately containing the delimiter survives. See design note 1.
 * @public
 */
export function parseMultiValue(
  raw: unknown,
  delimiter: string = MULTI_VALUE_DELIMITER,
): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v));
  if (raw === null || raw === undefined) return [];

  const text = String(raw);
  if (text === '') return [];

  const out: string[] = [];
  let current = '';
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === delimiter) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  // A trailing lone backslash is data, not a dangling escape.
  if (escaped) current += '\\';
  out.push(current);

  return out;
}

/** @public */
export interface ChipLayout {
  readonly text: string;
  readonly x: number;
  readonly width: number;
}

/** @public */
export interface ChipLayoutResult {
  readonly chip: ReadonlyArray<ChipLayout>;
  /** Count not drawn, for a "+N" badge. Zero when everything fit. */
  readonly overflowCount: number;
  /** Badge geometry, present only when `overflowCount > 0`. */
  readonly overflow?: { readonly x: number; readonly width: number };
}

/** @public */
export interface ChipLayoutOption {
  /** Usable cell width in CSS px. */
  readonly width: number;
  /** Text measurement with the cell font applied. */
  readonly measure: (text: string) => number;
  /** Horizontal padding inside each chip. Default 6. */
  readonly chipPadding?: number;
  /** Gap between chips. Default 4. */
  readonly gap?: number;
}

/**
 * Lay chips out left to right, reserving room for the overflow badge.
 * @public
 */
export function layoutChip(
  value: ReadonlyArray<string>,
  option: ChipLayoutOption,
): ChipLayoutResult {
  const { width, measure } = option;
  const chipPadding = option.chipPadding ?? 6;
  const gap = option.gap ?? 4;

  const chip: ChipLayout[] = [];
  let x = 0;

  for (let i = 0; i < value.length; i++) {
    const text = value[i]!;
    const chipWidth = measure(text) + chipPadding * 2;
    const remaining = value.length - i;

    // Reserve badge width whenever chips remain beyond this one, so the badge
    // never has to overlap a chip that was already committed to.
    const badgeWidth =
      remaining > 1 ? measure(`+${remaining - 1}`) + chipPadding * 2 + gap : 0;

    if (x + chipWidth + badgeWidth > width) {
      const overflowCount = value.length - chip.length;
      if (overflowCount <= 0) break;
      return {
        chip,
        overflowCount,
        overflow: { x, width: measure(`+${overflowCount}`) + chipPadding * 2 },
      };
    }

    chip.push({ text, x, width: chipWidth });
    x += chipWidth + gap;
  }

  return { chip, overflowCount: 0 };
}

/** @public */
export interface MultiSelectEditorConfig {
  readonly options: ReadonlyArray<MultiSelectOption>;
  readonly id?: string;
  /** Allow values not present in `options`. Default false. */
  readonly allowCustom?: boolean;
  /** Cap on selected values. Default unlimited. */
  readonly maxSelected?: number;
  readonly delimiter?: string;
}

/** Filter options by a query, matching value or label, case-insensitively. @public */
export function filterOption(
  option: ReadonlyArray<MultiSelectOption>,
  query: string,
): MultiSelectOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...option];
  return option.filter(
    (o) =>
      o.value.toLowerCase().includes(q) || (o.label ?? '').toLowerCase().includes(q),
  );
}

/**
 * Toggle a value in the selected set, honouring `maxSelected`.
 * Exported so the popover's behaviour is testable without the DOM.
 * @public
 */
export function toggleValue(
  selected: ReadonlyArray<string>,
  value: string,
  maxSelected?: number,
): string[] {
  if (selected.includes(value)) return selected.filter((v) => v !== value);
  if (maxSelected !== undefined && selected.length >= maxSelected) return [...selected];
  return [...selected, value];
}

/**
 * Multi-select editor: a chip row plus a filterable option list.
 * @public
 */
export function createMultiSelectEditor(config: MultiSelectEditorConfig): CellEditor {
  const delimiter = config.delimiter ?? MULTI_VALUE_DELIMITER;

  return {
    id: config.id ?? 'multi-select',
    mount(ctx: CellEditContext): CellEditorInstance {
      let selected = parseMultiValue(ctx.initialText ?? ctx.value ?? '', delimiter).filter(
        (v) => v !== '',
      );
      let activeIndex = 0;

      const root = document.createElement('div');
      root.setAttribute('role', 'combobox');
      root.setAttribute('aria-expanded', 'true');
      root.setAttribute('aria-haspopup', 'listbox');
      root.style.cssText =
        'box-sizing:border-box;width:100%;min-height:100%;margin:0;padding:2px 4px;' +
        'border:2px solid #6ea8fe;outline:none;background:#0b0d10;color:#e7e9ec;' +
        'font-family:inherit;font-size:inherit;display:flex;flex-wrap:wrap;gap:4px;' +
        'align-items:center;position:relative;';

      const chipHost = document.createElement('span');
      chipHost.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;';

      const input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('aria-label', 'Filter options');
      input.style.cssText =
        'flex:1 1 60px;min-width:60px;border:none;outline:none;background:transparent;' +
        'color:inherit;font:inherit;';

      const list = document.createElement('div');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-multiselectable', 'true');
      list.style.cssText =
        'position:absolute;top:100%;left:0;right:0;z-index:10;max-height:180px;' +
        'overflow:auto;background:#12151a;border:1px solid #2a2f37;';

      const renderChip = (): void => {
        chipHost.replaceChildren();
        for (const value of selected) {
          const option = config.options.find((o) => o.value === value);
          const chip = document.createElement('span');
          chip.dataset['chip'] = value;
          chip.style.cssText =
            `display:inline-flex;align-items:center;gap:4px;padding:1px 6px;` +
            `border-radius:10px;background:${option?.color ?? '#2a2f37'};font-size:0.9em;`;
          chip.textContent = option?.label ?? value;

          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = '×';
          remove.setAttribute('aria-label', `Remove ${option?.label ?? value}`);
          remove.style.cssText =
            'border:none;background:none;color:inherit;cursor:pointer;padding:0;font:inherit;';
          remove.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            selected = selected.filter((v) => v !== value);
            renderChip();
            renderList();
          });

          chip.appendChild(remove);
          chipHost.appendChild(chip);
        }
      };

      const visibleOption = (): MultiSelectOption[] => filterOption(config.options, input.value);

      const renderList = (): void => {
        list.replaceChildren();
        const option = visibleOption();
        if (activeIndex >= option.length) activeIndex = Math.max(0, option.length - 1);

        option.forEach((o, index) => {
          const row = document.createElement('div');
          row.setAttribute('role', 'option');
          row.dataset['value'] = o.value;
          const isSelected = selected.includes(o.value);
          row.setAttribute('aria-selected', String(isSelected));
          row.style.cssText =
            `padding:4px 8px;cursor:pointer;` +
            `background:${index === activeIndex ? '#1d2530' : 'transparent'};`;
          row.textContent = `${isSelected ? '✓ ' : ''}${o.label ?? o.value}`;
          row.addEventListener('mousedown', (e) => {
            // mousedown, not click: the grid commits on blur, and a click would
            // blur the editor before the toggle ran.
            e.preventDefault();
            selected = toggleValue(selected, o.value, config.maxSelected);
            renderChip();
            renderList();
          });
          list.appendChild(row);
        });
      };

      input.addEventListener('input', () => {
        activeIndex = 0;
        renderList();
      });

      input.addEventListener('keydown', (e) => {
        const option = visibleOption();

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          activeIndex = option.length === 0 ? 0 : (activeIndex + 1) % option.length;
          renderList();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          activeIndex =
            option.length === 0 ? 0 : (activeIndex - 1 + option.length) % option.length;
          renderList();
          return;
        }
        if (e.key === 'Enter') {
          const active = option[activeIndex];
          if (active !== undefined) {
            e.preventDefault();
            e.stopPropagation();
            selected = toggleValue(selected, active.value, config.maxSelected);
            input.value = '';
            renderChip();
            renderList();
            return;
          }
          if (config.allowCustom === true && input.value.trim() !== '') {
            e.preventDefault();
            e.stopPropagation();
            selected = toggleValue(selected, input.value.trim(), config.maxSelected);
            input.value = '';
            renderChip();
            renderList();
          }
          // Otherwise fall through: the grid commits the edit on Enter.
          return;
        }
        if (e.key === 'Backspace' && input.value === '' && selected.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          selected = selected.slice(0, -1);
          renderChip();
          renderList();
        }
      });

      root.appendChild(chipHost);
      root.appendChild(input);
      root.appendChild(list);
      renderChip();
      renderList();

      return {
        element: root,
        getValue: () => formatMultiValue(selected, delimiter),
        focus: () => input.focus(),
      };
    },
  };
}
