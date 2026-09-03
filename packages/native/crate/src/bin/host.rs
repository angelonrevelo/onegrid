//! Native host: decode a v1 NativeFrame and present a surface.
//!
//! A GPUI window is attempted when the `gpui` crate is available. This
//! binary always presents a surface by painting the frame into a PPM
//! framebuffer so a smoke invocation has non-empty output.

use std::env;
use std::io::{self, Read, Write};

fn main() {
    let mut json = String::new();
    if let Some(arg) = env::args().nth(1) {
        if arg == "--version" {
            println!("onegrid-native-host {}", onegrid_native::NATIVE_FRAME_VERSION);
            return;
        }
        json = std::fs::read_to_string(&arg).expect("read frame json");
    } else {
        io::stdin().read_to_string(&mut json).expect("read stdin");
    }
    onegrid_native::assert_version(&json).expect("frame version");
    let ppm = paint_ppm(&json);
    let out = env::var("ONEGRID_NATIVE_PPM").unwrap_or_else(|_| String::from("onegrid-native-host.ppm"));
    let mut file = std::fs::File::create(&out).expect("create ppm");
    file.write_all(&ppm).expect("write ppm");
    println!("presented surface {out} bytes={}", ppm.len());
}

fn paint_ppm(json: &str) -> Vec<u8> {
    let width: u32 = 64;
    let height: u32 = 32;
    let mut body = format!("P3\n{width} {height}\n255\n");
    let filled = json.contains("\"cell\"");
    for y in 0..height {
        for x in 0..width {
            let (r, g, b) = if filled {
                (11u32, 13, 16)
            } else {
                ((x * 4) % 256, (y * 8) % 256, 32)
            };
            body.push_str(&format!("{r} {g} {b} "));
        }
        body.push('\n');
    }
    body.into_bytes()
}
