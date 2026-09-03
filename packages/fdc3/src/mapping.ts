// =============================================================================
// Column -> context mapping
//
// The hard part of FDC3 adoption is not the wire call, it is agreeing what a
// row *means*. A row in a positions blotter is an `fdc3.position`; the same
// grid filtered to a security master is an `fdc3.instrument`. The adopter is
// the only party who knows which, so they declare it once:
//
//   defineContextMapping(schema, {
//     type: 'fdc3.instrument',
//     field: { 'id.ticker': fromColumn('symbol'), name: fromColumn('long_name') },
//   })
//
// Two decisions shape this API.
//
// First, targets are dotted paths rather than a nested object literal. One
// grammar then expresses every context type including the nested-instrument
// ones (`instrument.id.ISIN`) and the array-valued ones
// (`instruments[0].id.ticker`), instead of a bespoke sub-mapping API per type.
//
// Second, validation happens at *definition* time against the grid's Schema,
// not at broadcast time. A mapping that references a column the grid does not
// have, or that omits an identifier the standard requires, is a programming
// error — it should fail on the developer's machine, loudly, not silently
// broadcast a context that every peer app rejects. `defineContextMapping`
// therefore throws; `validateContextMapping` is the non-throwing form for
// tooling that wants to report rather than crash.
//
// Runtime nullability is a different matter and is not an error: a row where
// the ISIN column is null simply cannot produce an instrument, so
// `rowToContext` returns null and the bridge broadcasts nothing.
// =============================================================================

import type { ColumnType, Schema } from '@onegrid/protocol';

import type { Fdc3Context, Fdc3ContextType } from './context.js';
import { FDC3_CONTEXT_TYPE } from './context.js';
import { getPath, parsePath, pathCovers, setPath } from './path.js';

/**
 * A grid row as the adopter holds it — a bag of column-id-keyed cell values.
 * @public
 */
export type GridRow = Readonly<Record<string, unknown>>;

/**
 * Where one context field's value comes from: a grid column (optionally
 * transformed) or a literal baked into every context this mapping produces.
 * @public
 */
export type ContextFieldSource =
  | {
      readonly column: string;
      /** Runs on the raw cell value before it is written into the context. */
      readonly transform?: (value: unknown, row: GridRow) => unknown;
    }
  | { readonly value: unknown };

/**
 * Reads a context field from a grid column.
 * @public
 */
export function fromColumn(
  column: string,
  transform?: (value: unknown, row: GridRow) => unknown,
): ContextFieldSource {
  return transform ? { column, transform } : { column };
}

/**
 * Bakes a literal into every context this mapping produces — `currency: 'USD'`
 * on a single-currency blotter, or a fixed `market.MIC`.
 * @public
 */
export function fromValue(value: unknown): ContextFieldSource {
  return { value };
}

/**
 * The declaration an adopter writes. `field` keys are dotted context paths.
 * @public
 */
export interface ContextMappingSpec<T extends Fdc3ContextType = Fdc3ContextType> {
  readonly type: T;
  readonly field: Readonly<Record<string, ContextFieldSource>>;
}

/** @public */
export type MappingFindingCode =
  | 'unknown-context-type'
  | 'empty-mapping'
  | 'malformed-path'
  | 'unknown-column'
  | 'non-numeric-column'
  | 'missing-required-field';

/**
 * One problem with a mapping. Every finding is fatal — there is no warning
 * tier, because a mapping that is merely "probably wrong" produces contexts
 * peer apps silently drop, which is the worst failure mode available.
 * @public
 */
export interface MappingFinding {
  readonly code: MappingFindingCode;
  readonly message: string;
  /** Context path the finding concerns, when it concerns one. */
  readonly path?: string;
  /** Grid column the finding concerns, when it concerns one. */
  readonly column?: string;
}

/** @public */
export class ContextMappingError extends Error {
  readonly finding: readonly MappingFinding[];
  constructor(type: string, finding: readonly MappingFinding[]) {
    super(
      `invalid ${type} mapping: ${finding.map((f) => f.message).join('; ')}`,
    );
    this.name = 'ContextMappingError';
    this.finding = finding;
  }
}

/**
 * A validated mapping. `rowToContext` is the whole point: it is pure, it never
 * throws, and it returns null when the row cannot satisfy the context type's
 * required fields.
 * @public
 */
export interface ContextMapping<T extends Fdc3ContextType = Fdc3ContextType> {
  readonly type: T;
  readonly spec: ContextMappingSpec<T>;
  /** Column ids this mapping reads, in declaration order. */
  readonly column: readonly string[];
  readonly rowToContext: (row: GridRow) => Extract<Fdc3Context, { type: T }> | null;
}

// -----------------------------------------------------------------------------
// The standard's required fields
// -----------------------------------------------------------------------------

interface Requirement {
  /** `all` = every path must be covered; `anyOf` = at least one. */
  readonly kind: 'all' | 'anyOf';
  readonly path: readonly string[];
  readonly hint: string;
}

/**
 * Transcribed from the FDC3 2.0 context schemas. `anyOf` on the identifier
 * bags is deliberate: the standard requires an `id` with at least one known
 * identifier, not a specific one — a desk keyed on CUSIP is as valid as one
 * keyed on ISIN.
 */
const REQUIREMENT: Readonly<Record<Fdc3ContextType, readonly Requirement[]>> = {
  'fdc3.instrument': [
    {
      kind: 'anyOf',
      path: ['id.ticker', 'id.ISIN', 'id.FIGI', 'id.CUSIP', 'id.PERMID', 'id.LEI'],
      hint: 'an instrument needs at least one identifier (ticker, ISIN, FIGI, CUSIP, PERMID, LEI)',
    },
  ],
  'fdc3.contact': [
    {
      kind: 'anyOf',
      path: ['id.email', 'id.FDS_ID'],
      hint: 'a contact needs id.email or id.FDS_ID',
    },
  ],
  'fdc3.country': [
    {
      kind: 'anyOf',
      path: ['id.ISOALPHA2', 'id.ISOALPHA3', 'id.COUNTRY_ISOALPHA2', 'id.COUNTRY_ISOALPHA3'],
      hint: 'a country needs an ISO 3166 alpha-2 or alpha-3 identifier',
    },
  ],
  'fdc3.organization': [
    {
      kind: 'anyOf',
      path: ['id.LEI', 'id.PERMID', 'id.FDS_ID'],
      hint: 'an organization needs id.LEI, id.PERMID or id.FDS_ID',
    },
  ],
  'fdc3.position': [
    {
      kind: 'all',
      path: ['instrument', 'holding'],
      hint: 'a position needs an instrument and a holding',
    },
  ],
  'fdc3.portfolio': [
    {
      kind: 'all',
      path: ['positions'],
      hint: 'a portfolio needs at least positions[0]',
    },
  ],
  'fdc3.chart': [
    {
      kind: 'all',
      path: ['instruments'],
      hint: 'a chart needs at least instruments[0]',
    },
  ],
  'fdc3.timerange': [
    {
      kind: 'anyOf',
      path: ['startTime', 'endTime'],
      hint: 'a timerange needs startTime or endTime',
    },
  ],
  'fdc3.valuation': [
    {
      kind: 'all',
      path: ['value', 'currency'],
      hint: 'a valuation needs value and currency',
    },
  ],
};

/**
 * Paths whose leaf must be a number on the wire. Peers parse these as numbers;
 * a string sneaking through is a silent interop break, so the mapping is
 * checked against the column's declared type and the value is coerced at
 * conversion time.
 */
const NUMERIC_LEAF = new Set(['holding', 'value', 'price']);

const NUMERIC_COLUMN_TYPE = new Set<ColumnType>([
  'int8', 'int16', 'int32', 'int64',
  'uint8', 'uint16', 'uint32', 'uint64',
  'float32', 'float64', 'decimal',
]);

function leafOf(path: string): string {
  const part = path.split('.');
  return part[part.length - 1]!.replace(/\[\d+\]/g, '');
}

function isNumericPath(path: string): boolean {
  return NUMERIC_LEAF.has(leafOf(path));
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/**
 * Checks a mapping against a grid schema without throwing. Returns an empty
 * array when the mapping is sound.
 * @public
 */
export function validateContextMapping(
  schema: Schema,
  spec: ContextMappingSpec,
): readonly MappingFinding[] {
  const finding: MappingFinding[] = [];

  if (!(FDC3_CONTEXT_TYPE as readonly string[]).includes(spec.type)) {
    return [
      {
        code: 'unknown-context-type',
        message: `unknown context type "${spec.type}"`,
      },
    ];
  }

  const columnType = new Map(schema.map((column) => [column.id, column.type]));
  const entry = Object.entries(spec.field);

  if (entry.length === 0) {
    finding.push({ code: 'empty-mapping', message: 'mapping declares no fields' });
  }

  for (const [path, source] of entry) {
    if (!parsePath(path)) {
      finding.push({
        code: 'malformed-path',
        message: `malformed context path "${path}"`,
        path,
      });
      continue;
    }
    if (!('column' in source)) continue;

    const type = columnType.get(source.column);
    if (type === undefined) {
      finding.push({
        code: 'unknown-column',
        message: `path "${path}" reads column "${source.column}", which is not in the schema`,
        path,
        column: source.column,
      });
      continue;
    }
    // A transform is the adopter taking responsibility for the conversion, so
    // it suppresses the type check — parsing "1.2M" into a number is exactly
    // what transforms are for.
    if (isNumericPath(path) && source.transform === undefined && !NUMERIC_COLUMN_TYPE.has(type)) {
      finding.push({
        code: 'non-numeric-column',
        message: `path "${path}" must be numeric but column "${source.column}" is ${type}; supply a transform`,
        path,
        column: source.column,
      });
    }
  }

  const mappedPath = entry.map(([path]) => path);
  for (const requirement of REQUIREMENT[spec.type]) {
    const covered = requirement.path.filter((required) =>
      mappedPath.some((path) => pathCovers(path, required)),
    );
    const satisfied =
      requirement.kind === 'all'
        ? covered.length === requirement.path.length
        : covered.length > 0;
    if (!satisfied) {
      finding.push({
        code: 'missing-required-field',
        message: `${spec.type}: ${requirement.hint}`,
      });
    }
  }

  return finding;
}

// -----------------------------------------------------------------------------
// Definition
// -----------------------------------------------------------------------------

function coerce(path: string, value: unknown): unknown {
  if (!isNumericPath(path)) return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function requirementMet(built: Record<string, unknown>, type: Fdc3ContextType): boolean {
  for (const requirement of REQUIREMENT[type]) {
    const present = requirement.path.filter((path) => {
      const value = getPath(built, path);
      if (value === undefined || value === null) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === 'string') return value.length > 0;
      return true;
    });
    const satisfied =
      requirement.kind === 'all' ? present.length === requirement.path.length : present.length > 0;
    if (!satisfied) return false;
  }
  return true;
}

/**
 * Validates a mapping against the grid schema and compiles it into a
 * `rowToContext` converter. Throws `ContextMappingError` if the mapping does
 * not cover the fields FDC3 requires for the target type, or references a
 * column the schema does not declare.
 * @public
 */
export function defineContextMapping<T extends Fdc3ContextType>(
  schema: Schema,
  spec: ContextMappingSpec<T>,
): ContextMapping<T> {
  const finding = validateContextMapping(schema, spec);
  if (finding.length > 0) throw new ContextMappingError(spec.type, finding);

  const entry = Object.entries(spec.field);
  const column = entry
    .map(([, source]) => ('column' in source ? source.column : null))
    .filter((id): id is string => id !== null);

  const rowToContext = (row: GridRow): Extract<Fdc3Context, { type: T }> | null => {
    const built: Record<string, unknown> = { type: spec.type };

    for (const [path, source] of entry) {
      let value: unknown;
      if ('column' in source) {
        const raw = row[source.column];
        value = source.transform ? source.transform(raw, row) : raw;
      } else {
        value = source.value;
      }
      value = coerce(path, value);
      // Null and undefined are omitted rather than written: FDC3 consumers
      // check for key presence, and an explicit null reads as "known to be
      // absent", which is a different and usually wrong claim.
      if (value === undefined || value === null) continue;
      setPath(built, path, value);
    }

    // Nested instrument shapes need their own discriminator; the adopter maps
    // `instrument.id.ticker` and should not have to also write the type tag.
    stampNestedType(built, spec.type);

    if (!requirementMet(built, spec.type)) return null;
    return built as Extract<Fdc3Context, { type: T }>;
  };

  return { type: spec.type, spec, column, rowToContext };
}

/** Writes the `type` discriminator onto nested instrument / position objects. */
function stampNestedType(built: Record<string, unknown>, type: Fdc3ContextType): void {
  const stamp = (value: unknown, nested: Fdc3ContextType): void => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      (value as Record<string, unknown>).type = nested;
    }
  };
  const stampEach = (value: unknown, nested: Fdc3ContextType): void => {
    if (Array.isArray(value)) for (const item of value) stamp(item, nested);
  };

  if (type === 'fdc3.position') stamp(built.instrument, 'fdc3.instrument');
  if (type === 'fdc3.chart') stampEach(built.instruments, 'fdc3.instrument');
  if (type === 'fdc3.portfolio') {
    stampEach(built.positions, 'fdc3.position');
    if (Array.isArray(built.positions)) {
      for (const position of built.positions) {
        if (typeof position === 'object' && position !== null) {
          stamp((position as Record<string, unknown>).instrument, 'fdc3.instrument');
        }
      }
    }
  }
}
