# @onegrid/native

GPUI native-host protocol for oneGrid. The TypeScript encoder is the spec; the Rust crate in `crate/` matches it.

Default `cargo test` has **no** GPUI dependency. The host binary paints a PPM surface. A real GPU window is an opt-in:

```
cargo build --manifest-path crate/Cargo.toml --features gpui --bin onegrid-native-gpui
ONEGRID_NATIVE_SMOKE=1 ./onegrid-native-gpui frame.json
```
