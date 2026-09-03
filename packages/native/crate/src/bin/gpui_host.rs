//! GPUI window that paints a NativeFrame. Built only with `--features gpui`.
//!
//!   cargo build --manifest-path crate/Cargo.toml --features gpui --bin onegrid-native-gpui
//!   ONEGRID_NATIVE_SMOKE=1 ./onegrid-native-gpui frame.json
//!
//! Smoke mode opens the window then quits so a CI/agent invocation cannot hang
//! in the platform run loop.

use std::env;
use std::io::{self, Read};

use gpui::{
    div, px, rgb, size, App, Context, IntoElement, Render, SharedString, TitlebarOptions, Window,
    WindowBounds, WindowOptions,
};

struct NativeSurface {
    label: SharedString,
}

impl Render for NativeSurface {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .bg(rgb(0x0b0d10))
            .text_color(rgb(0xe7e9ec))
            .p_4()
            .child(self.label.clone())
    }
}

fn main() {
    let mut json = String::new();
    if let Some(arg) = env::args().nth(1) {
        if arg == "--version" {
            println!(
                "onegrid-native-gpui {}",
                onegrid_native::NATIVE_FRAME_VERSION
            );
            return;
        }
        json = std::fs::read_to_string(&arg).expect("read frame json");
    } else {
        io::stdin().read_to_string(&mut json).expect("read stdin");
    }
    onegrid_native::assert_version(&json).expect("frame version");
    let smoke = env::var("ONEGRID_NATIVE_SMOKE").is_ok();
    let label = SharedString::from(format!(
        "oneGrid native v{} · {} bytes · cells={}",
        onegrid_native::NATIVE_FRAME_VERSION,
        json.len(),
        json.matches("\"text\"").count()
    ));

    gpui_platform::application().run(move |cx: &mut App| {
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(size(px(720.), px(420.)))),
                titlebar: Some(TitlebarOptions {
                    title: Some("oneGrid native".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |_window, cx| cx.new(|_| NativeSurface { label: label.clone() }),
        )
        .expect("open GPUI window");
        println!("presented GPUI window bytes={}", json.len());
        if smoke {
            cx.quit();
        }
    });
}
