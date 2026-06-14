---
"@onegrid/core": minor
---

Add an optional `GridTheme.groupBackground` for the row-grouping / tree group-header band. The renderer previously hardcoded the group-row background to `#1b1f26`, so a light theme got a dark slate band; `drawGroupRow` now uses `theme.groupBackground ?? theme.headerBackground`. Backward-compatible — when unset it falls back to `headerBackground`, which equals the prior hardcoded value in the default dark theme, so existing themes render unchanged. Light/custom themes can now give group rows a matching band.
