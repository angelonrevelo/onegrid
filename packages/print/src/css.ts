// =============================================================================
// The `@media print` stylesheet emitter.
//
// PDF generation is the right answer for a report you archive or email. It is
// the wrong answer for "the user pressed Ctrl+P": the browser's own print
// pipeline already knows the installed paper size, the printer's unprintable
// margin and the user's scale preference, and it repaints text as vectors at
// the printer's real DPI rather than at the screen's.
//
// So this module emits CSS that makes the LIVE DOM printable, using the three
// print primitives the CSS Paged Media and Fragmentation specs give us and
// almost nobody wires up:
//
//   @page { size; margin }         — real paper geometry, honoured by every
//                                    modern engine; `size: A4 landscape` also
//                                    flips the print dialog's default.
//   thead { display: table-header-group }
//                                  — NATIVE header repetition. The browser
//                                    repeats the thead on every printed page
//                                    with no JavaScript and no measurement.
//                                    This is why the print path uses a real
//                                    <table>: only table-header-group gets
//                                    this behaviour.
//   break-inside: avoid            — the no-split-a-row invariant, expressed
//                                    to the fragmenter instead of computed.
//
// Plus the unglamorous half that decides whether a print looks professional:
// hiding interactive chrome (scrollbars, resize handles, filter buttons,
// sticky overlays), forcing exact colour reproduction so conditional
// background fills survive the printer's ink-saving heuristics, and expanding
// virtualised/height-constrained containers that would otherwise print one
// viewport of rows and stop.
// =============================================================================

import { resolvePageBox } from './page';
import type { PageOption } from './types';

/** @public */
export interface PrintStylesheetOption extends PageOption {
  /**
   * Selector scope for the grid root. Everything is emitted under this, so
   * the stylesheet can be injected globally without touching the rest of the
   * page. Default `.onegrid`.
   */
  readonly scope?: string;
  /**
   * Extra selectors to hide while printing, on top of the built-in chrome
   * list (toolbars, resizers, scrollbars, menus).
   */
  readonly hideSelector?: ReadonlyArray<string>;
  /** Repeat `thead` on every page via `table-header-group`. Default true. */
  readonly repeatHeader?: boolean;
  /** Emit `break-inside: avoid` on rows. Default true. */
  readonly avoidRowBreak?: boolean;
  /** Force background/colour printing with `print-color-adjust: exact`. Default true. */
  readonly exactColor?: boolean;
  /** Body font size in points for the printed table. Default 9. */
  readonly fontSize?: number;
  /** Grid rule colour. Default `#c8c8c8`. */
  readonly ruleColor?: string;
  /**
   * CSS `@page` scale is not a real property; a scale factor is applied with
   * a transform on the grid root instead. 1 disables it.
   */
  readonly scaleFactor?: number;
}

const BUILT_IN_HIDDEN: readonly string[] = [
  '.onegrid-toolbar',
  '.onegrid-scrollbar',
  '.onegrid-resizer',
  '.onegrid-menu',
  '.onegrid-filter-button',
  '.onegrid-context-menu',
  '.onegrid-overlay',
  '[data-onegrid-chrome]',
];

function pageSizeRule(option: PrintStylesheetOption): string {
  const size = option.size ?? 'A4';
  const orientation = option.orientation ?? 'portrait';
  const box = resolvePageBox(option);
  const sizeValue =
    typeof size === 'string'
      ? `${size} ${orientation}`
      : `${round(box.width)}pt ${round(box.height)}pt`;
  const m = box.margin;
  return `@page {\n  size: ${sizeValue};\n  margin: ${round(m.top)}pt ${round(m.right)}pt ${round(m.bottom)}pt ${round(m.left)}pt;\n}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Produce a complete `@media print` stylesheet for a oneGrid instance.
 *
 * The returned string is a standalone stylesheet — inject it into a `<style>`
 * element, ship it in a `.css` file, or hand it to `printHtmlDocument`.
 * @public
 */
export function printStylesheet(option: PrintStylesheetOption = {}): string {
  const scope = option.scope ?? '.onegrid';
  const fontSize = option.fontSize ?? 9;
  const ruleColor = option.ruleColor ?? '#c8c8c8';
  const hidden = [...BUILT_IN_HIDDEN, ...(option.hideSelector ?? [])];
  const scaleFactor = option.scaleFactor ?? 1;

  const part: string[] = [];
  part.push(pageSizeRule(option));
  part.push('@media print {');

  // Colour fidelity first: without this, conditional backgrounds vanish in
  // Chrome and Safari because "print backgrounds" defaults to off.
  if (option.exactColor !== false) {
    part.push(
      `  ${scope}, ${scope} * {\n    -webkit-print-color-adjust: exact;\n    print-color-adjust: exact;\n  }`,
    );
  }

  // Interactive chrome has no meaning on paper.
  part.push(`  ${hidden.map((s) => `${scope} ${s}`).join(',\n  ')} {\n    display: none !important;\n  }`);

  // A virtualised grid is a fixed-height scroll port. On paper it must become
  // an ordinary flowing block or only the visible rows print.
  part.push(
    `  ${scope},\n  ${scope} .onegrid-viewport,\n  ${scope} .onegrid-body {\n` +
      '    height: auto !important;\n' +
      '    max-height: none !important;\n' +
      '    overflow: visible !important;\n' +
      '    position: static !important;\n' +
      '    transform: none !important;\n' +
      '  }',
  );

  part.push(
    `  ${scope} table {\n    width: 100%;\n    border-collapse: collapse;\n    font-size: ${fontSize}pt;\n    table-layout: fixed;\n  }`,
  );

  if (option.repeatHeader !== false) {
    // The whole point of the DOM print path.
    part.push(
      `  ${scope} thead {\n    display: table-header-group;\n  }\n` +
        `  ${scope} tfoot {\n    display: table-footer-group;\n  }\n` +
        `  ${scope} thead th {\n    break-inside: avoid;\n    break-after: avoid;\n  }`,
    );
  } else {
    part.push(`  ${scope} thead {\n    display: table-row-group;\n  }`);
  }

  if (option.avoidRowBreak !== false) {
    part.push(
      `  ${scope} tr,\n  ${scope} .onegrid-row {\n    break-inside: avoid;\n    page-break-inside: avoid;\n  }`,
    );
    // A group header stranded at the foot of a page is the classic widow.
    part.push(
      `  ${scope} .onegrid-group-header {\n    break-inside: avoid;\n    break-after: avoid;\n  }`,
    );
  }

  part.push(
    `  ${scope} td,\n  ${scope} th {\n    border: 0.5pt solid ${ruleColor};\n    padding: 2pt 4pt;\n    overflow: hidden;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n  }`,
  );
  part.push(`  ${scope} .onegrid-cell-numeric {\n    text-align: right;\n  }`);
  part.push(`  ${scope} .onegrid-page-break {\n    break-before: page;\n  }`);

  if (scaleFactor !== 1) {
    part.push(
      `  ${scope} {\n    transform: scale(${round(scaleFactor)});\n    transform-origin: top left;\n    width: ${round(100 / scaleFactor)}%;\n  }`,
    );
  }

  part.push('}');
  return part.join('\n\n');
}
