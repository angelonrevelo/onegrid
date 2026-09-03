// =============================================================================
// @onegrid/embed — the block descriptor and its migration chain.
//
// An embedded block outlives the code that wrote it. Someone pastes a oneGrid
// link into a Notion page in 2026 and opens that page in 2029; the bundle
// serving the block will have been rewritten several times over, but the
// descriptor stored in the host's document is frozen at whatever shape we
// emitted the day they pasted it. That asymmetry is the whole reason this file
// exists, and it drives three decisions:
//
//   1. The descriptor is plain JSON. No class instances, no Dates, no Maps —
//      anything that does not survive JSON.parse(JSON.stringify(x)) is
//      forbidden, because the host stores it in its own document model and
//      hands it back verbatim.
//   2. Every descriptor carries `schemaVersion` as its first field, so a reader
//      can dispatch on version before trusting any other key.
//   3. Reading is always migrateBlock(raw) — never a direct cast. The migration
//      chain is a ladder of single-step functions (v1→v2, v2→v3), each of which
//      only has to understand two adjacent shapes. Adding v4 means writing one
//      more rung, not revisiting the earlier ones.
//
// Forward compatibility is deliberately NOT attempted: a v4 descriptor read by
// v3 code throws rather than guessing. Silently dropping keys we do not
// understand would let a host quietly discard a user's filter and render a
// grid that lies. Loud failure is the honest behaviour, and the host can fall
// back to the unfurl card.
// =============================================================================

import type { FilterModel, GroupingModel, SortModel } from '@onegrid/protocol';

// -----------------------------------------------------------------------------
// Current shape
// -----------------------------------------------------------------------------

/**
 * Schema version this build writes. Bump whenever the current shape changes in
 * a way an older reader cannot interpret, and add a matching rung to the
 * migration ladder in {@link migrateBlock}.
 *
 * @public
 */
export const BLOCK_SCHEMA_VERSION = 3;

/**
 * Where the embedded grid gets its row.
 *
 * `url` points at an endpoint speaking the oneGrid block protocol; `named`
 * refers to a dataset the embedding page has already registered by key (the
 * right choice when the data sits behind auth and must not appear in a link);
 * `inline` carries the rows in the descriptor itself, which is only viable for
 * small blocks — see the ceiling documented on `encodeBlockUrl`.
 *
 * @public
 */
export interface EmbedSourceRef {
  readonly kind: 'url' | 'named' | 'inline';
  /** URL, dataset key, or the empty string when `kind` is `inline`. */
  readonly ref: string;
  /** Row carried in-descriptor. Only meaningful when `kind` is `inline`. */
  readonly row?: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

/**
 * One column as the block remembers it. Intentionally a narrower projection
 * than core's `ColumnDef` — renderers and comparators are functions, and
 * functions do not serialise. The embedded runtime rehydrates behaviour from
 * `id` + `type` against its own registry.
 *
 * @public
 */
export interface EmbedColumn {
  readonly id: string;
  readonly displayName?: string;
  readonly width?: number;
  readonly type?: 'string' | 'number' | 'boolean' | 'date';
  readonly hidden?: boolean;
}

/**
 * The view state a reader expects restored: what the block was sorted,
 * filtered and grouped by at the moment it was embedded.
 *
 * @public
 */
export interface EmbedViewState {
  readonly sort: SortModel;
  readonly filter: FilterModel;
  readonly grouping?: GroupingModel;
}

/**
 * Theme carried with the block. A string names a built-in; the record form
 * carries explicit design tokens so a block pasted into a dark host still
 * reads correctly without the host knowing anything about oneGrid.
 *
 * @public
 */
export type EmbedTheme = 'light' | 'dark' | 'auto' | Readonly<Record<string, string>>;

/**
 * The complete, JSON-serialisable description of an embedded grid. Everything
 * required to reconstitute the block lives here; nothing else does.
 *
 * @public
 */
export interface EmbedBlock {
  readonly schemaVersion: number;
  /** Stable identity of this block within the host document. */
  readonly id: string;
  readonly title?: string;
  readonly source: EmbedSourceRef;
  readonly column: ReadonlyArray<EmbedColumn>;
  readonly state: EmbedViewState;
  readonly theme: EmbedTheme;
  /** Named layout / behaviour preset the embedded runtime should apply. */
  readonly preset?: string;
}

// -----------------------------------------------------------------------------
// Historical shapes
//
// Kept as explicit types rather than `any` so the migration rungs typecheck,
// and exported so an adopter writing their own storage layer can reason about
// what may still be sitting in their database.
// -----------------------------------------------------------------------------

/**
 * v1 — the first shipped shape. A single sort field, column ids only, and the
 * data source flattened to a bare URL string.
 *
 * @public
 */
export interface EmbedBlockV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title?: string;
  /** Bare endpoint URL. */
  readonly source: string;
  /** Column ids, in display order. Plural because v1 shipped it that way. */
  readonly columns: ReadonlyArray<string>;
  readonly sort?: { readonly columnId: string; readonly direction: 'asc' | 'desc' } | null;
  readonly theme?: 'light' | 'dark';
}

/**
 * v2 — structured columns, a multi-column sort and a filter, but the source is
 * still a bare URL and there is no grouping or preset.
 *
 * @public
 */
export interface EmbedBlockV2 {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly title?: string;
  readonly source: string;
  readonly columns: ReadonlyArray<EmbedColumn>;
  readonly sort: SortModel;
  readonly filter: FilterModel;
  readonly theme: EmbedTheme;
}

/**
 * Any descriptor shape this build knows how to read.
 *
 * @public
 */
export type AnyEmbedBlock = EmbedBlockV1 | EmbedBlockV2 | EmbedBlock;

// -----------------------------------------------------------------------------
// Migration ladder
// -----------------------------------------------------------------------------

function migrateV1ToV2(block: EmbedBlockV1): EmbedBlockV2 {
  // v1 stored column ids only; a v2 column is that id with everything else
  // left undefined so the runtime falls back to its own defaults.
  const column: EmbedColumn[] = block.columns.map((id) => ({ id }));
  // v1's optional single sort becomes a one-entry (or empty) sort model.
  const sort: SortModel = block.sort
    ? [{ columnId: block.sort.columnId, direction: block.sort.direction }]
    : [];
  return {
    schemaVersion: 2,
    id: block.id,
    source: block.source,
    columns: column,
    sort,
    // v1 had no filter concept at all; "no filter" is null, not an empty node.
    filter: null,
    theme: block.theme ?? 'auto',
    ...(block.title === undefined ? {} : { title: block.title }),
  };
}

function migrateV2ToV3(block: EmbedBlockV2): EmbedBlock {
  // v3 promotes the bare URL string to a tagged reference, which is what made
  // `named` and `inline` sources expressible. Every v2 source was, by
  // definition of the v2 contract, a URL.
  const source: EmbedSourceRef = { kind: 'url', ref: block.source };
  return {
    schemaVersion: 3,
    id: block.id,
    source,
    column: block.columns,
    // v3 groups sort / filter / grouping under one `state` object so future
    // view state (pivot, pinning) has an obvious home instead of accreting at
    // the top level.
    state: { sort: block.sort, filter: block.filter },
    theme: block.theme,
    ...(block.title === undefined ? {} : { title: block.title }),
  };
}

/**
 * Detect a descriptor's schema version without trusting the rest of it.
 * Returns 0 for anything that is not a versioned block object.
 *
 * @public
 */
export function detectBlockVersion(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) return 0;
  const v = (raw as { schemaVersion?: unknown }).schemaVersion;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
}

/**
 * Walk a descriptor of any known past version up to
 * {@link BLOCK_SCHEMA_VERSION}. A descriptor already at the current version is
 * validated and returned. Throws on an unrecognised or future version rather
 * than guessing at fields it cannot interpret.
 *
 * @public
 */
export function migrateBlock(raw: unknown): EmbedBlock {
  const version = detectBlockVersion(raw);
  if (version === 0) {
    throw new Error('@onegrid/embed: not an EmbedBlock — missing or invalid `schemaVersion`.');
  }
  if (version > BLOCK_SCHEMA_VERSION) {
    throw new Error(
      `@onegrid/embed: block schemaVersion ${version} is newer than this build understands (${BLOCK_SCHEMA_VERSION}). Upgrade @onegrid/embed.`,
    );
  }
  // `EmbedBlock.schemaVersion` is a plain `number` rather than a literal —
  // deliberately, so a descriptor from a future minor still types — which means
  // the equality checks below narrow the historical members but not the current
  // one. The casts are load-bearing, not laziness.
  let current = raw as AnyEmbedBlock;
  if (current.schemaVersion === 1) current = migrateV1ToV2(current as EmbedBlockV1);
  if (current.schemaVersion === 2) current = migrateV2ToV3(current as EmbedBlockV2);
  return assertBlock(current);
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/**
 * Structural check on a current-version block. Runs after migration so a rung
 * that produces nonsense fails here rather than three frames later inside the
 * renderer, where the stack trace would name the wrong culprit.
 *
 * @public
 */
export function assertBlock(value: unknown): EmbedBlock {
  if (typeof value !== 'object' || value === null) {
    throw new Error('@onegrid/embed: block must be an object.');
  }
  const b = value as Partial<EmbedBlock>;
  if (b.schemaVersion !== BLOCK_SCHEMA_VERSION) {
    throw new Error(
      `@onegrid/embed: expected schemaVersion ${BLOCK_SCHEMA_VERSION}, got ${String(b.schemaVersion)}.`,
    );
  }
  if (typeof b.id !== 'string' || b.id.length === 0) {
    throw new Error('@onegrid/embed: block.id must be a non-empty string.');
  }
  const source = b.source;
  if (
    typeof source !== 'object' ||
    source === null ||
    (source.kind !== 'url' && source.kind !== 'named' && source.kind !== 'inline')
  ) {
    throw new Error("@onegrid/embed: block.source.kind must be one of 'url' | 'named' | 'inline'.");
  }
  if (typeof source.ref !== 'string') {
    throw new Error('@onegrid/embed: block.source.ref must be a string.');
  }
  const column: unknown = b.column;
  if (!Array.isArray(column)) {
    throw new Error('@onegrid/embed: block.column must be an array.');
  }
  for (const entry of column as ReadonlyArray<Partial<EmbedColumn>>) {
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new Error('@onegrid/embed: every block.column entry needs a non-empty string id.');
    }
  }
  const state = b.state;
  if (typeof state !== 'object' || state === null || !Array.isArray(state.sort)) {
    throw new Error('@onegrid/embed: block.state.sort must be an array.');
  }
  if (state.filter !== null && typeof state.filter !== 'object') {
    throw new Error('@onegrid/embed: block.state.filter must be a FilterNode or null.');
  }
  if (b.theme === undefined) {
    throw new Error('@onegrid/embed: block.theme is required.');
  }
  return b as EmbedBlock;
}

/**
 * Build a current-version block from the parts an adopter actually has,
 * defaulting the rest. Cheaper than hand-writing the descriptor, and it can
 * never emit a stale `schemaVersion`.
 *
 * @public
 */
export function createBlock(option: {
  readonly id: string;
  readonly source: EmbedSourceRef;
  readonly column: ReadonlyArray<EmbedColumn>;
  readonly title?: string;
  readonly state?: Partial<EmbedViewState>;
  readonly theme?: EmbedTheme;
  readonly preset?: string;
}): EmbedBlock {
  return {
    schemaVersion: BLOCK_SCHEMA_VERSION,
    id: option.id,
    source: option.source,
    column: option.column,
    state: {
      sort: option.state?.sort ?? [],
      filter: option.state?.filter ?? null,
      ...(option.state?.grouping === undefined ? {} : { grouping: option.state.grouping }),
    },
    theme: option.theme ?? 'auto',
    ...(option.title === undefined ? {} : { title: option.title }),
    ...(option.preset === undefined ? {} : { preset: option.preset }),
  };
}

// -----------------------------------------------------------------------------
// Serialisation
// -----------------------------------------------------------------------------

// Top-level key order is fixed rather than left to object insertion order so
// two structurally identical blocks serialise to byte-identical strings. Hosts
// diff embedded block payloads to decide whether a document changed; unstable
// key order would make every re-render look like an edit and spam version
// history.
const KEY_ORDER: ReadonlyArray<string> = [
  'schemaVersion',
  'id',
  'title',
  'source',
  'column',
  'state',
  'theme',
  'preset',
];

function orderKey(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  // Only the block root carries schemaVersion, so this reorders exactly one
  // object and leaves nested filter / sort nodes untouched.
  if (record.schemaVersion === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    if (record[k] !== undefined) out[k] = record[k];
  }
  // Preserve any key we do not know about rather than dropping it — a host may
  // have round-tripped a descriptor written by a newer patch build.
  for (const k of Object.keys(record)) {
    if (!(k in out) && record[k] !== undefined) out[k] = record[k];
  }
  return out;
}

/**
 * Serialise a block to canonical JSON: current schema version, deterministic
 * top-level key order, no whitespace.
 *
 * @public
 */
export function serializeBlock(block: EmbedBlock): string {
  return JSON.stringify(assertBlock(block), orderKey);
}

/**
 * Parse and migrate a serialised block. Accepts any version this build knows,
 * always returns the current shape.
 *
 * @public
 */
export function deserializeBlock(text: string): EmbedBlock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`@onegrid/embed: block is not valid JSON — ${String(err)}`);
  }
  return migrateBlock(raw);
}
