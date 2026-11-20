//! Draws a translated thread (post, then comments) as a PNG.
//!
//! Built for Workers Free, which allows 10 ms of CPU per request: fonts are parsed and
//! glyphs rasterized once per isolate and cached, so a warm render is a few milliseconds.
//! Input is JSON (see [`Thread`]), output is PNG bytes.

use fontdue::{Font, FontSettings, Metrics};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::HashMap;

static REGULAR: &[u8] = include_bytes!("../assets/noto-sans-400.ttf");
static MEDIUM: &[u8] = include_bytes!("../assets/noto-sans-500.ttf");
/// Twemoji tiles side by side, in the order of `emoji.txt`.
static EMOJI_PNG: &[u8] = include_bytes!("../assets/emoji.png");
static EMOJI_TXT: &str = include_str!("../assets/emoji.txt");
const EMOJI_TILE: usize = 28;

// Layout in CSS pixels, multiplied by `Thread::scale`.
const WIDTH: f32 = 480.0;
const PAD_X: f32 = 10.0;
const PAD_TOP: f32 = 8.0;
const PAD_BOTTOM: f32 = 9.0;
const FONT: f32 = 13.5;
const SMALL: f32 = 11.0;
const LINE: f32 = FONT * 1.35;
const GAP: f32 = 6.0;
const ROW_GAP: f32 = 4.0;
const POST_AVATAR: f32 = 22.0;
const COMMENT_AVATAR: f32 = 18.0;
const BG: [u8; 3] = [255, 255, 255];
const INK: [u8; 3] = [0x1b, 0x1f, 0x23];
const MUTED: [u8; 3] = [0x8a, 0x93, 0x9c];
const RULE: [u8; 3] = [0xe6, 0xe9, 0xec];

#[derive(Deserialize)]
pub struct Row {
    pub name: String,
    /// `#rrggbb`, used for the name and the initials circle.
    pub color: String,
    pub text: String,
    pub time: String,
    pub initials: String,
    /// Base64 JPEG profile photo. Without one, initials are drawn.
    #[serde(default)]
    pub avatar: Option<String>,
}

#[derive(Deserialize)]
pub struct Thread {
    pub scale: f32,
    pub post: Row,
    pub comments: Vec<Row>,
    /// Muted line under the post, such as how many older comments were left out.
    #[serde(default)]
    pub note: Option<String>,
}

struct Emoji {
    index: HashMap<String, usize>,
    longest: usize,
    /// RGBA, `EMOJI_TILE` rows of `count * EMOJI_TILE` pixels.
    pixels: Vec<u8>,
    stride: usize,
}

struct Assets {
    faces: [Font; 2],
    glyphs: HashMap<(usize, char, u32), (Metrics, Vec<u8>)>,
    emoji: Emoji,
}

thread_local! {
    static ASSETS: RefCell<Option<Assets>> = const { RefCell::new(None) };
}

/// Emoji are matched without U+FE0F, which senders include or omit inconsistently.
fn emoji_key(chars: &[char]) -> String {
    chars.iter().filter(|&&c| c != '\u{fe0f}').collect()
}

fn load_emoji() -> Emoji {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(EMOJI_PNG));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().expect("emoji atlas header");
    let mut pixels = vec![0; reader.output_buffer_size().expect("emoji atlas size")];
    let info = reader.next_frame(&mut pixels).expect("emoji atlas pixels");
    assert_eq!(info.color_type, png::ColorType::Rgba, "emoji atlas must be RGBA");
    let mut index = HashMap::new();
    let mut longest = 1;
    for (i, emoji) in EMOJI_TXT.lines().filter(|l| !l.is_empty()).enumerate() {
        let chars: Vec<char> = emoji.chars().collect();
        longest = longest.max(chars.len());
        index.insert(emoji_key(&chars), i);
    }
    Emoji { index, longest, pixels, stride: info.width as usize * 4 }
}

fn with_assets<R>(f: impl FnOnce(&mut Assets) -> R) -> R {
    ASSETS.with(|cell| {
        let mut slot = cell.borrow_mut();
        let assets = slot.get_or_insert_with(|| Assets {
            faces: [
                Font::from_bytes(REGULAR, FontSettings::default()).expect("regular font"),
                Font::from_bytes(MEDIUM, FontSettings::default()).expect("medium font"),
            ],
            glyphs: HashMap::new(),
            emoji: load_emoji(),
        });
        f(assets)
    })
}

impl Assets {
    fn glyph(&mut self, face: usize, c: char, px: f32) -> &(Metrics, Vec<u8>) {
        let key = (face, c, px.to_bits());
        if !self.glyphs.contains_key(&key) {
            let g = self.faces[face].rasterize(c, px);
            self.glyphs.insert(key, g);
        }
        &self.glyphs[&key]
    }
    fn advance(&mut self, face: usize, c: char, px: f32) -> f32 {
        self.glyph(face, c, px).0.advance_width
    }
    fn has(&self, face: usize, c: char) -> bool {
        self.faces[face].lookup_glyph_index(c) != 0
    }
}

fn hex(color: &str) -> [u8; 3] {
    let v = u32::from_str_radix(color.trim_start_matches('#'), 16).unwrap_or(0x555555);
    [(v >> 16) as u8, (v >> 8) as u8, v as u8]
}

struct Canvas {
    w: usize,
    h: usize,
    px: Vec<u8>,
}

impl Canvas {
    fn new(w: usize, h: usize) -> Self {
        Canvas { w, h, px: BG.repeat(w * h) }
    }
    fn blend(&mut self, x: i32, y: i32, color: [u8; 3], alpha: u32) {
        if x < 0 || y < 0 || x as usize >= self.w || y as usize >= self.h || alpha == 0 {
            return;
        }
        let i = (y as usize * self.w + x as usize) * 3;
        for k in 0..3 {
            let d = self.px[i + k] as u32;
            self.px[i + k] = ((color[k] as u32 * alpha + d * (255 - alpha)) / 255) as u8;
        }
    }
    fn rect(&mut self, x: i32, y: i32, w: i32, h: i32, color: [u8; 3]) {
        for yy in y..y + h {
            for xx in x..x + w {
                self.blend(xx, yy, color, 255);
            }
        }
    }
    fn glyph(&mut self, x: i32, baseline: i32, m: &Metrics, bitmap: &[u8], color: [u8; 3]) {
        let top = baseline - m.height as i32 - m.ymin;
        let left = x + m.xmin;
        for gy in 0..m.height {
            for gx in 0..m.width {
                let a = bitmap[gy * m.width + gx] as u32;
                self.blend(left + gx as i32, top + gy as i32, color, a);
            }
        }
    }
    /// Draws emoji tile `index` scaled to `size` pixels with its top-left at (x, y).
    fn emoji(&mut self, x: i32, y: i32, size: i32, emoji: &Emoji, index: usize) {
        for yy in 0..size {
            let sy = (yy as usize * EMOJI_TILE) / size as usize;
            for xx in 0..size {
                let sx = index * EMOJI_TILE + (xx as usize * EMOJI_TILE) / size as usize;
                let p = sy * emoji.stride + sx * 4;
                let px = &emoji.pixels[p..p + 4];
                self.blend(x + xx, y + yy, [px[0], px[1], px[2]], px[3] as u32);
            }
        }
    }
    /// Circle of diameter `d` at (x, y), filled from `sample(u, v)` with u, v in 0..1.
    fn circle(&mut self, x: i32, y: i32, d: i32, sample: impl Fn(f32, f32) -> [u8; 3]) {
        let r = d as f32 / 2.0;
        for yy in 0..d {
            for xx in 0..d {
                let dx = xx as f32 + 0.5 - r;
                let dy = yy as f32 + 0.5 - r;
                let edge = r - (dx * dx + dy * dy).sqrt();
                if edge <= -0.5 {
                    continue;
                }
                let alpha = ((edge + 0.5).min(1.0) * 255.0) as u32;
                let c = sample((xx as f32 + 0.5) / d as f32, (yy as f32 + 0.5) / d as f32);
                self.blend(x + xx, y + yy, c, alpha);
            }
        }
    }
}

#[derive(Clone, Copy)]
struct Style {
    face: usize,
    px: f32,
    color: [u8; 3],
}

#[derive(Clone, Copy)]
enum Item {
    Glyph(char),
    Emoji(usize),
}

/// A laid-out item, positioned relative to its text block.
struct Placed {
    x: f32,
    line: usize,
    item: Item,
    style: Style,
}

/// Splits text into drawable items: emoji from the atlas (longest match first) and glyphs
/// the font has. Anything else (unknown emoji, joiners, skin tones) is dropped.
fn items(assets: &Assets, style: Style, text: &[char]) -> Vec<Item> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let c = text[i];
        if c as u32 >= 0x2000 {
            let longest = assets.emoji.longest.min(text.len() - i);
            let found = (1..=longest)
                .rev()
                .find_map(|len| assets.emoji.index.get(&emoji_key(&text[i..i + len])).map(|&e| (len, e)));
            if let Some((len, e)) = found {
                out.push(Item::Emoji(e));
                i += len;
                continue;
            }
        }
        if assets.has(style.face, c) {
            out.push(Item::Glyph(c));
        }
        i += 1;
    }
    out
}

fn emoji_size(px: f32) -> f32 {
    (px * 1.05).round()
}

fn advance(assets: &mut Assets, style: Style, item: Item) -> f32 {
    match item {
        Item::Glyph(c) => assets.advance(style.face, c, style.px),
        Item::Emoji(_) => emoji_size(style.px) + style.px * 0.1,
    }
}

/// Greedy word wrap over styled runs. Returns placed items and the line count.
fn layout(assets: &mut Assets, runs: &[(String, Style)], width: f32) -> (Vec<Placed>, usize) {
    let mut out = Vec::new();
    let (mut x, mut line) = (0.0f32, 0usize);
    for (text, style) in runs {
        let style = *style;
        let space = assets.advance(style.face, ' ', style.px);
        for (p, paragraph) in text.split('\n').enumerate() {
            if p > 0 {
                x = 0.0;
                line += 1;
            }
            let mut first = true;
            for word in paragraph.split(' ') {
                let chars: Vec<char> = word.chars().collect();
                let word_items = items(assets, style, &chars);
                // A word made only of dropped characters must not leave a double space.
                if word_items.is_empty() && !word.is_empty() {
                    continue;
                }
                if !first && x > 0.0 {
                    x += space;
                }
                first = false;
                let width_of: f32 = word_items.iter().map(|&it| advance(assets, style, it)).sum();
                if x > 0.0 && x + width_of > width {
                    x = 0.0;
                    line += 1;
                }
                for item in word_items {
                    let a = advance(assets, style, item);
                    // Words longer than a line break anywhere.
                    if x > 0.0 && x + a > width {
                        x = 0.0;
                        line += 1;
                    }
                    out.push(Placed { x, line, item, style });
                    x += a;
                }
            }
        }
    }
    (out, line + 1)
}

fn decode_avatar(b64: &str) -> Option<(usize, usize, Vec<u8>)> {
    let bytes = base64_decode(b64)?;
    let mut decoder = jpeg_decoder::Decoder::new(&bytes[..]);
    let pixels = decoder.decode().ok()?;
    let info = decoder.info()?;
    let (w, h) = (info.width as usize, info.height as usize);
    let rgb = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => pixels,
        jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|&l| [l, l, l]).collect(),
        _ => return None,
    };
    (w > 0 && h > 0).then_some((w, h, rgb))
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let clean: Vec<u8> = s.bytes().filter(|&c| c != b'=' && !c.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

struct Laid<'a> {
    row: &'a Row,
    avatar: f32,
    placed: Vec<Placed>,
    lines: usize,
}

pub fn render_thread(thread: &Thread) -> Vec<u8> {
    let s = thread.scale;
    with_assets(|assets| {
        let font = FONT * s;
        let small = SMALL * s;
        let line_h = LINE * s;

        let laid: Vec<Laid> = std::iter::once(&thread.post)
            .chain(&thread.comments)
            .enumerate()
            .map(|(i, row)| {
                let is_post = i == 0;
                let avatar = if is_post { POST_AVATAR } else { COMMENT_AVATAR };
                let sep = if is_post { "\n" } else { " " };
                let runs = [
                    (row.name.clone(), Style { face: 1, px: font, color: hex(&row.color) }),
                    (format!("{sep}{} ", row.text), Style { face: 0, px: font, color: INK }),
                    (row.time.clone(), Style { face: 0, px: small, color: MUTED }),
                ];
                let (placed, lines) = layout(assets, &runs, (WIDTH - 2.0 * PAD_X - avatar - GAP) * s);
                Laid { row, avatar, placed, lines }
            })
            .collect();

        let row_h = |l: &Laid| (l.lines as f32 * line_h).max(l.avatar * s);
        let note_h = if thread.note.is_some() { line_h } else { 0.0 };
        let total = PAD_TOP * s
            + laid.iter().map(row_h).sum::<f32>()
            + ROW_GAP * s * laid.len().saturating_sub(2) as f32
            + 12.0 * s // gap, rule, gap under the post
            + note_h
            + PAD_BOTTOM * s;
        let mut canvas = Canvas::new((WIDTH * s) as usize, total.ceil() as usize);

        let lm = assets.faces[0].horizontal_line_metrics(font).expect("line metrics");
        let baseline_off = (line_h - (lm.ascent - lm.descent)) / 2.0 + lm.ascent;
        let x0 = PAD_X * s;

        let mut y = PAD_TOP * s;
        for (i, l) in laid.iter().enumerate() {
            draw_avatar(&mut canvas, assets, l, x0 as i32, (y + s) as i32, s);
            let tx = x0 + (l.avatar + GAP) * s;
            draw_items(&mut canvas, assets, &l.placed, tx, y, line_h, baseline_off);
            y += row_h(l);
            if i == 0 {
                y += 6.0 * s;
                canvas.rect(x0 as i32, y as i32, ((WIDTH - 2.0 * PAD_X) * s) as i32, s as i32, RULE);
                y += 6.0 * s;
                if let Some(note) = &thread.note {
                    let style = Style { face: 0, px: small, color: MUTED };
                    let (placed, _) = layout(assets, &[(note.clone(), style)], (WIDTH - 2.0 * PAD_X) * s);
                    draw_items(&mut canvas, assets, &placed, x0, y, line_h, baseline_off);
                    y += note_h;
                }
            } else {
                y += ROW_GAP * s;
            }
        }

        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, canvas.w as u32, canvas.h as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fastest);
        let mut writer = encoder.write_header().expect("png header");
        writer.write_image_data(&canvas.px).expect("png data");
        writer.finish().expect("png end");
        png
    })
}

fn draw_avatar(canvas: &mut Canvas, assets: &mut Assets, l: &Laid, x: i32, y: i32, s: f32) {
    let d = (l.avatar * s).round() as i32;
    if let Some((w, h, rgb)) = l.row.avatar.as_deref().and_then(decode_avatar) {
        canvas.circle(x, y, d, |u, v| {
            let sx = ((u * w as f32) as usize).min(w - 1);
            let sy = ((v * h as f32) as usize).min(h - 1);
            let p = (sy * w + sx) * 3;
            [rgb[p], rgb[p + 1], rgb[p + 2]]
        });
        return;
    }
    let color = hex(&l.row.color);
    canvas.circle(x, y, d, |_, _| color);
    let px = l.avatar * 0.4 * s;
    let initials: Vec<char> = l.row.initials.chars().filter(|&c| assets.has(1, c)).collect();
    let width: f32 = initials.iter().map(|&c| assets.advance(1, c, px)).sum();
    let m = assets.faces[1].horizontal_line_metrics(px).expect("line metrics");
    let mut ix = x as f32 + (d as f32 - width) / 2.0;
    let baseline = y as f32 + (d as f32 + m.ascent + m.descent) / 2.0;
    for c in initials {
        let (metrics, bitmap) = assets.glyph(1, c, px).clone();
        canvas.glyph(ix.round() as i32, baseline.round() as i32, &metrics, &bitmap, [255, 255, 255]);
        ix += metrics.advance_width;
    }
}

fn draw_items(
    canvas: &mut Canvas,
    assets: &mut Assets,
    placed: &[Placed],
    x: f32,
    y: f32,
    line_h: f32,
    baseline_off: f32,
) {
    for p in placed {
        let baseline = y + p.line as f32 * line_h + baseline_off;
        match p.item {
            Item::Glyph(c) => {
                let (metrics, bitmap) = assets.glyph(p.style.face, c, p.style.px).clone();
                canvas.glyph((x + p.x).round() as i32, baseline.round() as i32, &metrics, &bitmap, p.style.color);
            }
            Item::Emoji(e) => {
                let size = emoji_size(p.style.px);
                let top = baseline - size * 0.82;
                canvas.emoji((x + p.x).round() as i32, top.round() as i32, size as i32, &assets.emoji, e);
            }
        }
    }
}

// ---- WASM interface: write JSON with `alloc`, call `render`, read `output_ptr` ----

thread_local! {
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` and `len` must come from one `alloc` call.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Renders the JSON at (ptr, len). Returns the PNG length, or 0 for invalid input.
///
/// # Safety
/// (ptr, len) must be a readable buffer, such as one from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn render(ptr: *const u8, len: usize) -> usize {
    let input = std::slice::from_raw_parts(ptr, len);
    let png = match serde_json::from_slice::<Thread>(input) {
        Ok(thread) => render_thread(&thread),
        Err(_) => Vec::new(),
    };
    let n = png.len();
    OUTPUT.with(|o| *o.borrow_mut() = png);
    n
}

#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 {
    OUTPUT.with(|o| o.borrow().as_ptr())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(text: &str) -> Row {
        Row {
            name: "Олена K".into(),
            color: "#2468a8".into(),
            text: text.into(),
            time: "14:57".into(),
            initials: "ОK".into(),
            avatar: None,
        }
    }

    fn png_size(png: &[u8]) -> (u32, u32) {
        let reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().unwrap();
        (reader.info().width, reader.info().height)
    }

    #[test]
    fn renders_a_png_that_grows_with_comments() {
        let short = Thread { scale: 2.0, post: row("Post"), comments: vec![], note: None };
        let long = Thread {
            scale: 2.0,
            post: row("Post"),
            comments: (0..5).map(|i| row(&format!("Comment {i} 👍"))).collect(),
            note: Some("3 earlier comments not shown".into()),
        };
        let (w1, h1) = png_size(&render_thread(&short));
        let (w2, h2) = png_size(&render_thread(&long));
        assert_eq!((w1, w2), (960, 960));
        assert!(h2 > h1 + 5 * 36, "{h1} -> {h2}");
    }

    #[test]
    fn matches_emoji_with_or_without_variation_selector_and_drops_unknown_ones() {
        with_assets(|assets| {
            let style = Style { face: 0, px: 27.0, color: INK };
            let kinds = |text: &str| {
                let chars: Vec<char> = text.chars().collect();
                items(assets, style, &chars)
                    .iter()
                    .map(|i| match i {
                        Item::Glyph(c) => c.to_string(),
                        Item::Emoji(_) => "E".into(),
                    })
                    .collect::<String>()
            };
            assert_eq!(kinds("a❤️b"), "aEb");
            assert_eq!(kinds("a❤b"), "aEb");
            assert_eq!(kinds("🇺🇦!"), "E!");
            assert_eq!(kinds("👍🏽"), "E", "skin tone falls back to the default emoji");
            assert_eq!(kinds("x🦩y"), "xy", "emoji outside the set are dropped");
        });
    }

    #[test]
    fn a_dropped_emoji_word_leaves_one_space() {
        with_assets(|assets| {
            let style = Style { face: 0, px: 27.0, color: INK };
            let mut x_of_b = |text: &str| layout(assets, &[(text.into(), style)], 10_000.0).0.last().unwrap().x;
            assert_eq!(x_of_b("a 🦩 b"), x_of_b("a b"));
        });
    }

    #[test]
    fn decodes_base64() {
        assert_eq!(base64_decode("aGk=").unwrap(), b"hi");
        assert_eq!(base64_decode("AQID").unwrap(), [1, 2, 3]);
    }
}
