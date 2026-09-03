//! SQL compiler for the oneGrid Postgres extension.
//!
//! Mirrors `packages/pgrx/src/index.ts`. Default cargo test has no pgrx
//! dependency. `--features pg17` compiles `extension.rs` as a loadable
//! `#[pg_extern]` module (needs `pg_config` / cargo-pgrx).

/// Function name as installed in Postgres.
pub const FETCH_BLOCK_FUNCTION: &str = "onegrid_fetch_block";

/// True when `schema` is a bare SQL identifier.
pub fn is_bare_schema(schema: &str) -> bool {
    let mut chars = schema.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

/// True when `name` is `schema.table` or a single bare identifier.
pub fn is_qualified_or_bare(name: &str) -> bool {
    !name.is_empty() && name.split('.').all(is_bare_schema)
}

/// Quote a SQL string literal.
pub fn sql_literal(value: &str) -> String {
    let mut out = String::from("'");
    for c in value.chars() {
        if c == '\'' {
            out.push('\'');
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// The SQL a host runs against the installed function. Mirrors `compileFetchCall`.
pub fn compile_fetch_call(
    table_name: &str,
    primary_key: &str,
    page_limit: i32,
    cursor_row_id: Option<&str>,
    schema: &str,
) -> String {
    let cursor = match cursor_row_id {
        None => String::from("NULL"),
        Some(value) => sql_literal(value),
    };
    format!(
        "SELECT * FROM {schema}.{FETCH_BLOCK_FUNCTION}({}, {}, {page_limit}, {cursor});",
        sql_literal(table_name),
        sql_literal(primary_key),
    )
}

/// Inner SELECT the PL/pgSQL function (and the pgrx `#[pg_extern]`) execute.
pub fn compile_fetch_select(
    table_name: &str,
    primary_key: &str,
    page_limit: i32,
    cursor_row_id: Option<&str>,
) -> Result<String, &'static str> {
    if page_limit < 1 || page_limit > 10_000 {
        return Err("OG_PGRX_LIMIT");
    }
    if !is_qualified_or_bare(table_name) {
        return Err("OG_PGRX_TABLE");
    }
    if !is_bare_schema(primary_key) {
        return Err("OG_PGRX_PK");
    }
    Ok(match cursor_row_id {
        None => format!(
            "SELECT to_jsonb(t) AS row FROM {table_name} AS t ORDER BY {primary_key} ASC LIMIT {page_limit}"
        ),
        Some(cursor) => format!(
            "SELECT to_jsonb(t) AS row FROM {table_name} AS t WHERE {primary_key} > {} ORDER BY {primary_key} ASC LIMIT {page_limit}",
            sql_literal(cursor)
        ),
    })
}

#[cfg(feature = "pg17")]
mod extension;

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn accepts_public() {
        assert!(is_bare_schema("public"));
        assert!(is_bare_schema("onegrid"));
    }

    #[test]
    fn rejects_injection() {
        assert!(!is_bare_schema("public;drop"));
        assert!(!is_bare_schema(""));
        assert!(!is_qualified_or_bare("public.order;drop"));
    }

    #[test]
    fn quotes_apostrophe() {
        assert_eq!(sql_literal("O'Reilly"), "'O''Reilly'");
    }

    #[test]
    fn compile_fetch_call_quotes_cursor() {
        let sql = compile_fetch_call("public.order", "order_id", 50, Some("O'Reilly"), "public");
        assert!(sql.contains("public.onegrid_fetch_block"));
        assert!(sql.contains("'O''Reilly'"));
        assert!(sql.contains("50"));
    }

    #[test]
    fn compile_fetch_select_first_page() {
        let sql = compile_fetch_select("public.account", "account_id", 100, None).unwrap();
        assert!(sql.contains("SELECT to_jsonb(t) AS row FROM public.account"));
        assert!(sql.contains("ORDER BY account_id ASC LIMIT 100"));
    }
}

#[cfg(feature = "pg17")]
pub use extension::*;
