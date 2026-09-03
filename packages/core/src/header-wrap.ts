// =============================================================================
// Header text wrap + auto header height
//
// A narrow column with a long header ("Q3 Adjusted Gross Margin %") truncates
// to uselessness. Wrapping the header across lines and growing the header band
// to fit is the fix, and it has to be measured against the SAME canvas context
// the renderer paints with, or the measured height and the painted text
// disagree by a pixel or two and the last line clips.
//
// Design decisions, and why:
//
//   1. MEASUREMENT IS INJECTED, NOT ASSUMED. `wrapHeaderText` takes a
//      `measure(text) => number` function rather than a canvas. The renderer
//      passes `(t) => ctx.measureText(t).width` with the header font already
//      set; tests pass a deterministic fake. This is also what makes the
//      module testable in jsdom, where `measureText` does not really exist.
//
//   2. BREAKING IS WORD-FIRST, CHARACTER-SECOND. Words break on whitespace;
//      a single word longer than the column is broken mid-word rather than
//      overflowing, because a header that spills into its neighbour looks like
//      a rendering bug. Break opportunities also include `/` and `-`, which is
//      where real column names ("Rev/Cost", "Year-over-Year") want to break.
//
//   3. THE BAND IS SIZED BY THE TALLEST HEADER, ONCE. Every column shares one
//      header height — a ragged header band is worse than a slightly tall one —
//      so `headerHeightFor` takes all columns and returns a single height,
//      clamped to `maxLine` so one pathological header cannot eat the viewport.
// =============================================================================

/** @public */
export interface HeaderWrapOption {
  /** Available text width in CSS px (column width minus padding and sort icon). */
  readonly width: number;
  /** Text measurement, with the header font already applied. */
  readonly measure: (text: string) => number;
  /** Hard cap on line count. Beyond it, the last line is ellipsised. Default 3. */
  readonly maxLine?: number;
}

/** @public */
export interface WrappedHeader {
  readonly line: ReadonlyArray<string>;
  /** True when content was dropped and the last line ends in an ellipsis. */
  readonly truncated: boolean;
}

/** Characters after which a break is allowed without inserting a hyphen. */
const BREAK_AFTER = new Set(['/', '-', '–', '—', '_']);

/**
 * Split into break-eligible tokens, keeping the separators attached to the
 * token they follow so "Rev/Cost" can break as "Rev/" + "Cost".
 */
function tokenize(text: string): string[] {
  const token: string[] = [];
  let current = '';

  for (const char of text) {
    if (/\s/.test(char)) {
      if (current !== '') token.push(current);
      current = '';
      continue;
    }
    current += char;
    if (BREAK_AFTER.has(char)) {
      token.push(current);
      current = '';
    }
  }
  if (current !== '') token.push(current);
  return token;
}

/** Break a single over-long token to fit, character by character. */
function breakToken(
  token: string,
  width: number,
  measure: (t: string) => number,
): string[] {
  const line: string[] = [];
  let current = '';

  for (const char of token) {
    const next = current + char;
    if (current !== '' && measure(next) > width) {
      line.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current !== '') line.push(current);
  return line;
}

/**
 * Wrap header text to a column width.
 * @public
 */
export function wrapHeaderText(text: string, option: HeaderWrapOption): WrappedHeader {
  const { width, measure } = option;
  const maxLine = option.maxLine ?? 3;

  if (text === '' || width <= 0 || maxLine < 1) {
    return { line: text === '' ? [] : [text], truncated: false };
  }

  const line: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current !== '') line.push(current);
    current = '';
  };

  for (const token of tokenize(text)) {
    const candidate = current === '' ? token : `${current} ${token}`;

    if (measure(candidate) <= width) {
      current = candidate;
      continue;
    }

    flush();

    // A token that cannot fit on a line of its own must be broken.
    if (measure(token) > width) {
      const piece = breakToken(token, width, measure);
      for (let i = 0; i < piece.length; i++) {
        if (i === piece.length - 1) current = piece[i]!;
        else line.push(piece[i]!);
      }
    } else {
      current = token;
    }
  }
  flush();

  if (line.length <= maxLine) {
    return { line, truncated: false };
  }

  // Over budget: keep maxLine lines and ellipsise the last one to fit.
  const kept = line.slice(0, maxLine);
  const last = kept[maxLine - 1] ?? '';
  let ellipsised = last;
  while (ellipsised.length > 0 && measure(`${ellipsised}…`) > width) {
    ellipsised = ellipsised.slice(0, -1);
  }
  kept[maxLine - 1] = `${ellipsised}…`;

  return { line: kept, truncated: true };
}

/** @public */
export interface HeaderHeightOption {
  /** Line box height in CSS px. */
  readonly lineHeight: number;
  /** Vertical padding above + below the text block. */
  readonly padding: number;
  /** Never return less than this — keeps single-line headers at the theme height. */
  readonly minHeight: number;
}

/**
 * One header height for the whole band: the tallest wrapped header wins.
 * @public
 */
export function headerHeightFor(
  wrapped: ReadonlyArray<WrappedHeader>,
  option: HeaderHeightOption,
): number {
  const maxLine = wrapped.reduce((max, w) => Math.max(max, w.line.length), 1);
  return Math.max(option.minHeight, maxLine * option.lineHeight + option.padding);
}
