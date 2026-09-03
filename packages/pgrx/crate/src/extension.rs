//! Loadable Postgres extension. Compiled only with `--features pg17`.
//!
//! `cargo pgrx package` (when the CLI is installed) produces the `.so`/`.dll`.
//! `cargo build --features pg17` produces a cdylib if `pg_config` is on PATH.

use pgrx::prelude::*;

pgrx::pg_module_magic!();

/// Compile the inner SELECT the PL/pgSQL function would run. Returning the
/// statement lets a host without SPI still inspect the plan; Spi::connect
/// below executes it when Postgres is live.
#[pg_extern]
fn onegrid_compile_fetch(
    table_name: &str,
    primary_key: &str,
    page_limit: default!(i32, 100),
    cursor_row_id: default!(Option<&str>, None),
) -> String {
    crate::compile_fetch_select(table_name, primary_key, page_limit, cursor_row_id)
        .unwrap_or_else(|code| format!("/* {code} */"))
}

/// SSRM block-fetch. Mirrors `onegrid.onegrid_fetch_block` in the SQL compiler.
#[pg_extern]
fn onegrid_fetch_block(
    table_name: &str,
    primary_key: &str,
    page_limit: default!(i32, 100),
    cursor_row_id: default!(Option<&str>, None),
) -> Result<TableIterator<'static, (name!(row, JsonB),)>, spi::Error> {
    let sql = match crate::compile_fetch_select(table_name, primary_key, page_limit, cursor_row_id) {
        Ok(sql) => sql,
        Err(code) => pgrx::error!("onegrid_fetch_block: {code}"),
    };
    Spi::connect(|client| {
        let mut row = Vec::new();
        for tuple in client.select(&sql, None, &[])? {
            if let Ok(Some(value)) = tuple.get_by_name::<JsonB>("row") {
                row.push((value,));
            }
        }
        Ok(TableIterator::new(row))
    })
}
