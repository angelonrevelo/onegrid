# Research ledger — studio + native (2026-09-04)

Validated in the main loop against the opened page, not the search snippet.

[c1] Supabase documents a visual Table Editor plus a SQL Editor on top of a full Postgres, not a spreadsheet store — https://supabase.com/docs/guides/database/overview — high — competitor
[c2] Supabase Table Editor covers create/modify/delete tables, columns, rows, RLS, realtime, and foreign-key relationships — https://deepwiki.com/ananyakunisetty/supabase/2.2-documentation-site — medium — competitor
[c3] A May 2026 Supabase issue shows Cmd+Enter can save a column without applying the foreign key — https://github.com/supabase/supabase/issues/45759 — high — other
[c4] pgrx builds Postgres extensions in Rust and supports Postgres 13 through 19 — https://github.com/pgcentralfoundation/pgrx — high — product_form
[c5] cargo-pgrx init downloads and compiles every supported Postgres into PGRX_HOME — https://github.com/pgcentralfoundation/pgrx/tree/develop/cargo-pgrx — high — other
[c6] GPUI is Zed's hybrid immediate/retained GPU UI (Metal / wgpu / DX11), published independently as gpui-unofficial 1.19.0-pre on 2026-09-02 — https://lib.rs/crates/gpui-unofficial — high — product_form
[c7] embedded_gpui explores GPUI-in-Wasm as a plugin, not a library oneGrid can depend on in CI — https://github.com/zed-industries/embedded_gpui — medium — other
[c8] Booted links oneGrid by bundler alias and cannot install workspace:* packages; the pg adapter is unusable because booted holds no connection string — founder (docs/tunnelmind-onegrid-gap.md in ~/Code/booted) — high — competitor

Gaps still open:
- Exact cargo-pgrx wall-clock and disk cost on this Windows box
- Whether a GPUI view can consume NativeFrame JSON without a display-list rewrite
- Whether booted's SQL route already accepts `{ sql, param }` or needs a new handler
