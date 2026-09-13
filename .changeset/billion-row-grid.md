---
"@onegrid/core": minor
---

Mount and scroll a billion rows. A numeric `rowHeight` is now stored as one height plus sparse overrides (`UniformHeights`) instead of a per-row `Float32Array` and a Fenwick tree — at 5M rows that allocation was ~100 MB, at 1B rows ~24 GB. Expanded detail rows stay sparse. A per-row `Float32Array` `rowHeight` keeps the previous behaviour.

Once the scroll range is scaled (content taller than the ~16 Mpx scroll spacer), the mouse wheel is applied in content pixels, so a wheel notch moves a few rows rather than thousands, and a late browser `scroll` event no longer snaps a precise `scrollToRow` back by dozens of rows. Wheel handling below that scale is unchanged (left to the browser).

The sticky group row no longer walks from the top visible row back towards row 0 on every frame (25M `getRowMeta` calls per frame at row 25M). It uses a cached, per-frame-budgeted scan that converges to the same answer.

Measured in Chromium at 1B rows: mount 40 ms with no measurable heap growth, exact seek to any row, 59.9 fps median while scrolling.
