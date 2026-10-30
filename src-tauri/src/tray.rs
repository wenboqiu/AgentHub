//! 托盘图标：0 个未处理用普通图标，否则画红底白字数字（>9 显示 9+）

use tauri::image::Image;

#[cfg(windows)]
fn round_rect_cov(x: f32, y: f32, w: f32, h: f32, r: f32) -> f32 {
    let (cx, cy) = (w / 2.0, h / 2.0);
    let qx = (x - cx).abs() - (cx - r);
    let qy = (y - cy).abs() - (cy - r);
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    let d = outside + qx.max(qy).min(0.0) - r;
    (0.5 - d).clamp(0.0, 1.0)
}

pub fn badge_text(count: u32) -> String {
    if count > 9 {
        "9+".into()
    } else {
        count.to_string()
    }
}

#[cfg(windows)]
fn small_icon_size() -> u32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSMICON};
    (unsafe { GetSystemMetrics(SM_CXSMICON) }).clamp(16, 64) as u32
}

/// 红底白字数字图标；非 Windows 或找不到字体时返回 None（调用方回退到普通图标）
#[cfg(windows)]
pub fn badge(count: u32) -> Option<Image<'static>> {
    use ab_glyph::{point, Font, FontVec, PxScale, ScaleFont};
    use std::sync::OnceLock;

    static FONT: OnceLock<Option<FontVec>> = OnceLock::new();
    let font = FONT
        .get_or_init(|| {
            ["segoeuib.ttf", "arialbd.ttf"].iter().find_map(|f| {
                let p = std::path::Path::new("C:\\Windows\\Fonts").join(f);
                FontVec::try_from_vec(std::fs::read(p).ok()?).ok()
            })
        })
        .as_ref()?;

    let size = small_icon_size();
    let s = size as f32;
    let mut buf = vec![0u8; (size * size * 4) as usize];
    let rgb = [220u8, 68, 58];
    for y in 0..size {
        for x in 0..size {
            let c = round_rect_cov(x as f32 + 0.5, y as f32 + 0.5, s, s, s * 0.22);
            if c > 0.0 {
                let i = ((y * size + x) * 4) as usize;
                buf[i..i + 3].copy_from_slice(&rgb);
                buf[i + 3] = (c * 255.0) as u8;
            }
        }
    }

    let text = badge_text(count);
    let scale = PxScale::from(s * if text.len() > 1 { 0.66 } else { 0.78 });
    let sf = font.as_scaled(scale);
    let mut caret = 0.0;
    let mut glyphs = Vec::new();
    for ch in text.chars() {
        let g = sf.scaled_glyph(ch);
        let adv = sf.h_advance(g.id);
        glyphs.push((g, caret));
        caret += adv;
    }
    let outlined: Vec<_> = glyphs
        .into_iter()
        .filter_map(|(mut g, x)| {
            g.position = point(x, 0.0);
            font.outline_glyph(g)
        })
        .collect();
    let (mut minx, mut miny, mut maxx, mut maxy) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for o in &outlined {
        let b = o.px_bounds();
        minx = minx.min(b.min.x);
        miny = miny.min(b.min.y);
        maxx = maxx.max(b.max.x);
        maxy = maxy.max(b.max.y);
    }
    let dx = ((s - (maxx - minx)) / 2.0 - minx).round();
    let dy = ((s - (maxy - miny)) / 2.0 - miny).round();
    for o in &outlined {
        let b = o.px_bounds();
        o.draw(|gx, gy, c| {
            let x = (b.min.x + gx as f32 + dx) as i32;
            let y = (b.min.y + gy as f32 + dy) as i32;
            if x < 0 || y < 0 || x >= size as i32 || y >= size as i32 {
                return;
            }
            let i = ((y as u32 * size + x as u32) * 4) as usize;
            for k in 0..3 {
                buf[i + k] = (buf[i + k] as f32 * (1.0 - c) + 255.0 * c) as u8;
            }
        });
    }
    Some(Image::new_owned(buf, size, size))
}

#[cfg(not(windows))]
pub fn badge(_count: u32) -> Option<Image<'static>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badge_text_caps_at_9_plus() {
        assert_eq!(badge_text(1), "1");
        assert_eq!(badge_text(9), "9");
        assert_eq!(badge_text(10), "9+");
        assert_eq!(badge_text(120), "9+");
    }

    #[cfg(windows)]
    #[test]
    fn badge_draws_something() {
        if let Some(img) = badge(3) {
            assert!(img.rgba().iter().any(|b| *b != 0));
        }
    }
}
