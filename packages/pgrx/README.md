# @onegrid/pgrx

SSRM block-fetch as a Postgres function. Install with `psql -c "$(node -e "console.log(require('@onegrid/pgrx').compileExtensionSql())")"`.

Default `cargo test` of `crate/` has **no** pgrx / Postgres dependency. A loadable extension is an opt-in:

```
cargo pgrx package --manifest-path crate/Cargo.toml --features pg17
# or, if cargo-pgrx is missing but pg_config is on PATH:
cargo build --manifest-path crate/Cargo.toml --features pg17
```
