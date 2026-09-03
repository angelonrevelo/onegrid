// =============================================================================
// HTTP / fetch queryable
//
// Booted (and any host that will not hold a connection string in the
// process that renders the grid) reaches Postgres through `docker exec`
// or an SSH hop. `@onegrid/postgres` previously assumed a node-postgres
// client in the same process, which made the adapter unusable there.
//
// `createHttpQueryable` is the same `PgQueryable` surface over POST
// `{ sql, param }` → `{ row }`. The server on the other side runs the
// SQL; this process never sees a connection string.
// =============================================================================

import type { PgQueryable } from './datasource';

/**
 * Options for {@link createHttpQueryable}.
 * @public
 */
export interface HttpQueryableOption {
  /** Endpoint that accepts `{ sql, param }` and returns `{ row }`. */
  readonly url: string;
  /** Extra request headers (auth, tracing). */
  readonly header?: Readonly<Record<string, string>>;
  /** Injected fetch — defaults to globalThis.fetch. */
  readonly fetch?: typeof fetch;
}

/**
 * A `PgQueryable` that POSTs parameterized SQL to an HTTP endpoint.
 * The JSON body is `{ sql, param }`; the JSON response is `{ row }`
 * (singular — an array of row objects). `rows` is accepted as a
 * compatibility alias for servers that already speak node-postgres.
 * @public
 */
export function createHttpQueryable(option: HttpQueryableOption): PgQueryable {
  const fetchImpl = option.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async query(text, param) {
      const response = await fetchImpl(option.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(option.header ?? {}),
        },
        body: JSON.stringify({ sql: text, param: param ?? [] }),
      });
      if (!response.ok) {
        throw new Error(
          `[OG_PG_HTTP] ${response.status} ${response.statusText} from ${option.url}`,
        );
      }
      const body = (await response.json()) as {
        row?: ReadonlyArray<Record<string, unknown>>;
        rows?: ReadonlyArray<Record<string, unknown>>;
      };
      return { rows: body.row ?? body.rows ?? [] };
    },
  };
}
