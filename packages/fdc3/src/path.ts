// =============================================================================
// Context field paths
//
// A mapping declares targets as dotted paths — `id.ticker`, `holding`,
// `instrument.id.ISIN`, `instruments[0].id.ticker`. One path grammar covers
// every context type, including the nested-instrument shapes (position,
// chart, portfolio) that would otherwise need a bespoke sub-mapping API per
// type. The array index form is what makes `fdc3.chart` and `fdc3.portfolio`
// expressible from a single grid row.
//
// Internal to the package: adopters write path strings, never these nodes.
// =============================================================================

export type PathSegment =
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'index'; readonly index: number };

const PART_RE = /^([A-Za-z_$][\w$]*)((?:\[\d+\])*)$/;
const INDEX_RE = /\[(\d+)\]/g;

/**
 * Parses `a.b[2].c` into segments. Returns null for a malformed path so the
 * caller can report it as a validation finding rather than throwing from deep
 * inside a row conversion.
 */
export function parsePath(path: string): PathSegment[] | null {
  if (path.length === 0) return null;
  const segment: PathSegment[] = [];
  for (const part of path.split('.')) {
    const match = PART_RE.exec(part);
    if (!match) return null;
    segment.push({ kind: 'key', key: match[1]! });
    INDEX_RE.lastIndex = 0;
    for (const index of match[2]!.matchAll(INDEX_RE)) {
      segment.push({ kind: 'index', index: Number(index[1]) });
    }
  }
  return segment;
}

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

function readSegment(cursor: Container, segment: PathSegment): unknown {
  if (segment.kind === 'index') {
    return Array.isArray(cursor) ? cursor[segment.index] : undefined;
  }
  return Array.isArray(cursor) ? undefined : cursor[segment.key];
}

function writeSegment(cursor: Container, segment: PathSegment, value: unknown): void {
  if (segment.kind === 'index') {
    if (Array.isArray(cursor)) cursor[segment.index] = value;
    return;
  }
  if (!Array.isArray(cursor)) cursor[segment.key] = value;
}

/**
 * Writes `value` at `path`, creating intermediate objects and arrays as the
 * next segment dictates. A no-op when the path is malformed — validation has
 * already rejected those, so reaching here with one is impossible in practice.
 */
export function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segment = parsePath(path);
  if (!segment) return;
  let cursor: Container = root;
  for (let i = 0; i < segment.length - 1; i++) {
    const here = segment[i]!;
    const next = segment[i + 1]!;
    const child = readSegment(cursor, here);
    if (isContainer(child)) {
      cursor = child;
      continue;
    }
    const created: Container = next.kind === 'index' ? [] : {};
    writeSegment(cursor, here, created);
    cursor = created;
  }
  writeSegment(cursor, segment[segment.length - 1]!, value);
}

/** Reads the value at `path`, or undefined if any hop is missing. */
export function getPath(root: unknown, path: string): unknown {
  const segment = parsePath(path);
  if (!segment) return undefined;
  let cursor: unknown = root;
  for (const here of segment) {
    if (!isContainer(cursor)) return undefined;
    cursor = readSegment(cursor, here);
  }
  return cursor;
}

/**
 * True when `path` is at or below `prefix` — `id.ticker` covers the
 * requirement `id`, and `instrument.id.ISIN` covers `instrument`. Used by
 * required-field validation, which is stated in terms of the shallowest
 * field the standard demands.
 */
export function pathCovers(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  return path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}
