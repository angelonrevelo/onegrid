// =============================================================================
// On-the-spot query bench.
//
// Times one compiled statement against a queryable. The measurement is a
// library function so the playground trigger and the unit test drive the
// same path — not a second timer inside a React effect.
// =============================================================================

import { applyStatement } from './apply';
import type { CompiledStatement, PostgresQueryable } from './model';

/**
 * One measurement of a compiled statement.
 * @public
 */
export interface QueryBenchResult {
  readonly durationMs: number;
  readonly rowCount: number;
  readonly sql: string;
}

/**
 * Run `statement` against `queryable` and report wall-clock duration plus
 * the number of rows returned. Duration is `performance.now()` delta, always
 * a finite number ≥ 0.
 * @public
 */
export async function measureQuery(
  queryable: PostgresQueryable,
  statement: CompiledStatement,
): Promise<QueryBenchResult> {
  const started = performance.now();
  const row = await applyStatement(queryable, statement);
  const ended = performance.now();
  const durationMs = ended - started;
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error('[OG_BENCH] durationMs is not a finite number ≥ 0');
  }
  return {
    durationMs,
    rowCount: row.length,
    sql: statement.sql,
  };
}
