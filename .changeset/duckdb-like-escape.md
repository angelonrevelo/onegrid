---
"@onegrid/duckdb": patch
---

Fix string filters against DuckDB. DuckDB's `LIKE` has no default escape character, so the backslash escapes the builder adds for `%`, `_` and `\` were matched literally and any quick-filter or set-filter search containing those characters matched nothing; every `LIKE` / `ILIKE` now declares `ESCAPE '\'`. `ILIKE` on a `BIGINT`, `DOUBLE` or `TIMESTAMP` column is a DuckDB binder error, so a quick filter spanning every column failed outright; `contains`, `notContains`, `startsWith` and `endsWith` now cast the column to `VARCHAR`.
