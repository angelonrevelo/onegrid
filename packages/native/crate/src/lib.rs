//! Native-host protocol for oneGrid. Mirrors `packages/native/src/index.ts`.
//!
//! A GPUI view (Zed's GPU UI) deserialises a `NativeFrame` and paints
//! cell quads. This crate does **not** depend on `gpui`: pulling Zed's
//! toolchain into the JS monorepo's CI is a host concern, not a library
//! one. What we own is the frame layout.

/// Protocol version. Must equal `NATIVE_FRAME_VERSION` in the TS package.
pub const NATIVE_FRAME_VERSION: u32 = 1;

/// True when `text` is a v1 frame (starts with `{"version":1`).
pub fn is_v1_frame(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("{\"version\":1") || trimmed.starts_with("{\"version\": 1")
}

/// Reject a future version the way `decodeFrame` does.
pub fn assert_version(text: &str) -> Result<(), &'static str> {
    if is_v1_frame(text) {
        Ok(())
    } else {
        Err("OG_NATIVE_VERSION")
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn accepts_v1() {
        assert!(assert_version("{\"version\":1,\"viewport\":{}}").is_ok());
    }

    #[test]
    fn rejects_v99() {
        assert_eq!(assert_version("{\"version\":99}"), Err("OG_NATIVE_VERSION"));
    }
}
