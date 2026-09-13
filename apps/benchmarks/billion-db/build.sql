-- The benchmark table for run.mjs. `{{row_count}}` is substituted by
-- `node run.mjs build <file.duckdb> <rows>`.
--
-- Shaped like a grid's server-side table: a monotonic id (keyset seeks), two
-- low-cardinality columns (set filters, group-by), a high-cardinality text
-- column (quick filter, distinct), a double and a timestamp (sort, and the
-- non-VARCHAR columns a quick filter has to cast). Values are hash-derived, so
-- a rebuild is byte-for-byte the same data.
--
-- Measured on the Windows dev box: 10M rows build in 14 s into 145 MB.

.timer on
CREATE TABLE row AS
SELECT
  i::BIGINT AS id,
  (['north','south','east','west','central','coastal','mountain','island'])[(hash(i) % 8)::INT + 1] AS region,
  (['active','pending','archived','pilot','churned'])[(hash(i * 7) % 5)::INT + 1] AS status,
  (['Aiko','Ben','Carmen','Dmitri','Elif','Farah','Gustavo','Hana','Ivan','Jun','Kofi','Lena','Mateo','Nia','Omar','Priya'])[(hash(i * 13) % 16)::INT + 1]
    || ' ' || (['Tanaka','Okafor','Silva','Novak','Reyes','Kim','Haddad','Larsen','Moreau','Singh','Adeyemi','Chen','Dvorak','Petrov','Saito','Vargas'])[(hash(i * 31) % 16)::INT + 1]
    || ' ' || (hash(i * 97) % 10000)::VARCHAR AS name,
  round((hash(i * 11) % 1000000) / 100.0, 2)::DOUBLE AS amount,
  TIMESTAMP '2020-01-01' + to_seconds((hash(i * 17) % 157766400)::BIGINT) AS created
FROM range({{row_count}}) t(i);
SELECT count(*) AS row_count FROM row;
