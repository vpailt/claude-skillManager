//! Windows taskbar overlay badge — draws a small "N actions à traiter" badge
//! onto the app's taskbar button via `WebviewWindow::set_overlay_icon`
//! (`ITaskbarList3::SetOverlayIcon` under the hood).
//!
//! The badge image is rendered as a raw RGBA buffer with a tiny hand-coded 5x7
//! bitmap font — no image/text-rendering crate, no bundled assets, so it stays
//! within the single-.exe / binary-size constraints. `Image::new_owned` feeds
//! the buffer straight to Tauri without a PNG round-trip.
//!
//! The overlay lives on the *taskbar button*, which only exists while the main
//! window is shown. When the window is hidden to tray there is no button to
//! decorate, so the frontend re-applies the badge on focus/show (see
//! `src/hooks/useTaskbarBadge.ts`).

#[cfg(target_os = "windows")]
mod imp {
    use tauri::image::Image;
    use tauri::{AppHandle, Manager};

    /// Rendered badge resolution. Larger than the on-screen overlay (~16px) so
    /// Windows' downscale antialiases our blocky bitmap font.
    const SIZE: u32 = 32;

    /// Badge fill (red-600) and border (white) — conventional notification badge
    /// colors, chosen to read on top of the purple app icon.
    const FILL: [u8; 3] = [0xDC, 0x26, 0x26];
    const BORDER: [u8; 3] = [0xFF, 0xFF, 0xFF];

    /// 5x7 bitmap glyphs, one byte per row, bit 4 = leftmost column.
    fn glyph(c: char) -> [u8; 7] {
        match c {
            '0' => [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
            '1' => [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
            '2' => [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
            '3' => [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
            '4' => [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
            '5' => [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
            '6' => [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
            '7' => [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
            '8' => [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
            '9' => [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
            '+' => [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
            _ => [0; 7],
        }
    }

    /// Alpha-over a single pixel onto the RGBA buffer.
    fn blend_px(buf: &mut [u8], x: i32, y: i32, rgb: [u8; 3], a: f32) {
        if x < 0 || y < 0 || x >= SIZE as i32 || y >= SIZE as i32 || a <= 0.0 {
            return;
        }
        let i = ((y as u32 * SIZE + x as u32) * 4) as usize;
        let sa = a.clamp(0.0, 1.0);
        let da = buf[i + 3] as f32 / 255.0;
        let oa = sa + da * (1.0 - sa);
        if oa <= 0.0 {
            return;
        }
        let mix = |s: u8, d: u8| -> u8 {
            (((s as f32 * sa + d as f32 * da * (1.0 - sa)) / oa).round()).clamp(0.0, 255.0) as u8
        };
        buf[i] = mix(rgb[0], buf[i]);
        buf[i + 1] = mix(rgb[1], buf[i + 1]);
        buf[i + 2] = mix(rgb[2], buf[i + 2]);
        buf[i + 3] = (oa * 255.0).round() as u8;
    }

    /// Filled disc with a 1px soft (antialiased) edge.
    fn disc(buf: &mut [u8], cx: f32, cy: f32, radius: f32, rgb: [u8; 3]) {
        for y in 0..SIZE as i32 {
            for x in 0..SIZE as i32 {
                let dx = x as f32 - cx;
                let dy = y as f32 - cy;
                let dist = (dx * dx + dy * dy).sqrt();
                blend_px(buf, x, y, rgb, radius - dist + 0.5);
            }
        }
    }

    /// Blit one glyph (white, opaque) at scale.
    fn draw_glyph(buf: &mut [u8], c: char, ox: i32, oy: i32, scale: i32) {
        let rows = glyph(c);
        for (row, bits) in rows.iter().enumerate() {
            for col in 0..5i32 {
                if bits & (1 << (4 - col)) != 0 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            blend_px(buf, ox + col * scale + dx, oy + row as i32 * scale + dy, BORDER, 1.0);
                        }
                    }
                }
            }
        }
    }

    fn render(count: u32) -> Vec<u8> {
        let mut buf = vec![0u8; (SIZE * SIZE * 4) as usize];
        let c = (SIZE as f32 - 1.0) / 2.0;
        let r_outer = SIZE as f32 / 2.0 - 0.5;
        disc(&mut buf, c, c, r_outer, BORDER); // white ring
        disc(&mut buf, c, c, r_outer - 2.0, FILL); // red fill

        // 1..=9 → the digit; 10+ → "9+".
        let text = if count <= 9 {
            count.to_string()
        } else {
            "9+".to_string()
        };
        let chars: Vec<char> = text.chars().collect();
        if chars.len() == 1 {
            let scale = 3;
            let (gw, gh) = (5 * scale, 7 * scale);
            draw_glyph(
                &mut buf,
                chars[0],
                (SIZE as i32 - gw) / 2,
                (SIZE as i32 - gh) / 2,
                scale,
            );
        } else {
            let scale = 2;
            let (gw, gap, gh) = (5 * scale, 1, 7 * scale);
            let total = gw * 2 + gap;
            let ox = (SIZE as i32 - total) / 2;
            let oy = (SIZE as i32 - gh) / 2;
            draw_glyph(&mut buf, chars[0], ox, oy, scale);
            draw_glyph(&mut buf, chars[1], ox + gw + gap, oy, scale);
        }
        buf
    }

    pub fn apply(app: &AppHandle, count: u32) {
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        let res = if count == 0 {
            win.set_overlay_icon(None)
        } else {
            win.set_overlay_icon(Some(Image::new_owned(render(count), SIZE, SIZE)))
        };
        if let Err(e) = res {
            tracing::warn!("set_overlay_icon failed: {}", e);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use tauri::AppHandle;
    /// No-op: overlay icons are a Windows taskbar feature.
    pub fn apply(_app: &AppHandle, _count: u32) {}
}

/// Set (or clear, when `count == 0`) the taskbar badge showing the number of
/// pending actions. No-op on non-Windows platforms.
#[tauri::command]
pub fn set_taskbar_badge(app: tauri::AppHandle, count: u32) {
    tracing::debug!("set_taskbar_badge: {}", count);
    imp::apply(&app, count);
}
