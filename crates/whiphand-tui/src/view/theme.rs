//! Colours and glyphs, in one place. `NO_COLOR` and the terminal's colour
//! depth are honoured once, after the frame is drawn ([`strip_colour`],
//! [`reduce`]), so nothing here has to ask. The theme itself keeps to the 16
//! named colours; 256-colour and RGB styles come from agents' coloured log
//! lines.

use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier, Style};

pub fn dim() -> Style {
    Style::new().add_modifier(Modifier::DIM)
}

pub fn bold() -> Style {
    Style::new().add_modifier(Modifier::BOLD)
}

pub fn selected() -> Style {
    Style::new().add_modifier(Modifier::REVERSED)
}

pub fn error() -> Style {
    Style::new().fg(Color::Red)
}

/// A run's or a step's status.
pub fn status(status: &str) -> Style {
    match status {
        "running" => Style::new().fg(Color::Cyan),
        "succeeded" | "done" => Style::new().fg(Color::Green),
        "failed" | "interrupted" => Style::new().fg(Color::Red),
        "cancelled" => Style::new().fg(Color::Yellow),
        "pending" | "disabled" => dim(),
        _ => Style::new(),
    }
}

/// A step's status as one glyph.
pub fn glyph(status: &str) -> &'static str {
    match status {
        "done" => "✔",
        "running" => "●",
        "failed" => "✘",
        "interrupted" => "■",
        "disabled" => "–",
        _ => "○",
    }
}

pub fn waiting() -> Style {
    Style::new().fg(Color::Magenta).add_modifier(Modifier::BOLD)
}

pub fn warning_bar() -> Style {
    Style::new().fg(Color::Black).bg(Color::Yellow)
}

pub fn fatal_bar() -> Style {
    Style::new().fg(Color::White).bg(Color::Red)
}

/// Drops every colour from a drawn frame, keeping bold, dim and reverse:
/// what `NO_COLOR` asks for.
pub fn strip_colour(buf: &mut Buffer) {
    for cell in &mut buf.content {
        cell.fg = Color::Reset;
        cell.bg = Color::Reset;
    }
}

/// How many colours the terminal shows. crossterm writes RGB as 24-bit
/// sequences, which a 256- or 16-colour terminal garbles.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Depth {
    #[default]
    True,
    Ansi256,
    Ansi16,
}

impl Depth {
    /// From `COLORTERM`, `TERM` and Windows Terminal's `WT_SESSION`. The
    /// Windows console has no `TERM` and shows 24-bit colour.
    pub fn from_env(colorterm: Option<&str>, term: Option<&str>, wt_session: bool) -> Depth {
        if matches!(colorterm, Some("truecolor" | "24bit")) || wt_session {
            return Depth::True;
        }
        match term {
            None if cfg!(windows) => Depth::True,
            Some(t) if t.contains("256color") => Depth::Ansi256,
            _ => Depth::Ansi16,
        }
    }
}

/// Brings every colour in a drawn frame down to what the terminal shows.
pub fn reduce(buf: &mut Buffer, depth: Depth) {
    if depth == Depth::True {
        return;
    }
    for cell in &mut buf.content {
        cell.fg = reduce_colour(cell.fg, depth);
        cell.bg = reduce_colour(cell.bg, depth);
    }
}

fn reduce_colour(colour: Color, depth: Depth) -> Color {
    match (colour, depth) {
        (Color::Rgb(r, g, b), Depth::Ansi256) => Color::Indexed(to_256(r, g, b)),
        (Color::Rgb(r, g, b), Depth::Ansi16) => nearest_16(r, g, b),
        (Color::Indexed(i), Depth::Ansi16) if i >= 16 => {
            let (r, g, b) = rgb_of_256(i);
            nearest_16(r, g, b)
        }
        (Color::Indexed(i), Depth::Ansi16) => NAMED[i as usize],
        _ => colour,
    }
}

/// xterm's 6×6×6 cube levels.
const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];

fn distance((r1, g1, b1): (u8, u8, u8), (r2, g2, b2): (u8, u8, u8)) -> u32 {
    let d = |a: u8, b: u8| (i32::from(a) - i32::from(b)).unsigned_abs();
    d(r1, r2).pow(2) + d(g1, g2).pow(2) + d(b1, b2).pow(2)
}

/// The nearest of the 240 cube and grey-ramp colours (16..=255).
fn to_256(r: u8, g: u8, b: u8) -> u8 {
    let level = |c: u8| {
        (0..6)
            .min_by_key(|&i| (i32::from(LEVELS[i]) - i32::from(c)).unsigned_abs())
            .unwrap_or(0)
    };
    let (ri, gi, bi) = (level(r), level(g), level(b));
    let cube = 16 + 36 * ri + 6 * gi + bi;
    let cube_rgb = (LEVELS[ri], LEVELS[gi], LEVELS[bi]);
    let mean = (u32::from(r) + u32::from(g) + u32::from(b)) / 3;
    let grey = (mean.saturating_sub(3) / 10).min(23) as u8;
    let grey_level = 8 + 10 * grey;
    if distance((r, g, b), (grey_level, grey_level, grey_level)) < distance((r, g, b), cube_rgb) {
        232 + grey
    } else {
        cube as u8
    }
}

fn rgb_of_256(i: u8) -> (u8, u8, u8) {
    if i >= 232 {
        let v = 8 + 10 * (i - 232);
        return (v, v, v);
    }
    if i >= 16 {
        let i = usize::from(i - 16);
        return (LEVELS[i / 36], LEVELS[(i / 6) % 6], LEVELS[i % 6]);
    }
    PALETTE_16[usize::from(i)]
}

/// The 16 colours as xterm draws them, in index order.
const PALETTE_16: [(u8, u8, u8); 16] = [
    (0, 0, 0),
    (205, 0, 0),
    (0, 205, 0),
    (205, 205, 0),
    (0, 0, 238),
    (205, 0, 205),
    (0, 205, 205),
    (229, 229, 229),
    (127, 127, 127),
    (255, 0, 0),
    (0, 255, 0),
    (255, 255, 0),
    (92, 92, 255),
    (255, 0, 255),
    (0, 255, 255),
    (255, 255, 255),
];

const NAMED: [Color; 16] = [
    Color::Black,
    Color::Red,
    Color::Green,
    Color::Yellow,
    Color::Blue,
    Color::Magenta,
    Color::Cyan,
    Color::Gray,
    Color::DarkGray,
    Color::LightRed,
    Color::LightGreen,
    Color::LightYellow,
    Color::LightBlue,
    Color::LightMagenta,
    Color::LightCyan,
    Color::White,
];

fn nearest_16(r: u8, g: u8, b: u8) -> Color {
    (0..16)
        .min_by_key(|&i| distance((r, g, b), PALETTE_16[i]))
        .map_or(Color::Reset, |i| NAMED[i])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_depth_comes_from_the_environment() {
        assert_eq!(
            Depth::from_env(Some("truecolor"), Some("xterm-256color"), false),
            Depth::True
        );
        assert_eq!(
            Depth::from_env(None, Some("xterm-256color"), true),
            Depth::True
        );
        assert_eq!(
            Depth::from_env(None, Some("tmux-256color"), false),
            Depth::Ansi256
        );
        assert_eq!(Depth::from_env(None, Some("xterm"), false), Depth::Ansi16);
        assert_eq!(Depth::from_env(None, Some("linux"), false), Depth::Ansi16);
    }

    #[test]
    fn rgb_lands_on_the_cube_or_the_grey_ramp() {
        assert_eq!(to_256(255, 0, 0), 196);
        assert_eq!(to_256(0, 0, 0), 16);
        assert_eq!(to_256(255, 255, 255), 231);
        assert_eq!(to_256(128, 128, 128), 244);
        assert_eq!(to_256(95, 135, 175), 16 + 36 + 12 + 3);
        for i in 16..=255 {
            let (r, g, b) = rgb_of_256(i);
            assert_eq!(rgb_of_256(to_256(r, g, b)), (r, g, b), "{i}");
        }
    }

    #[test]
    fn sixteen_colours_keep_the_named_ones() {
        assert_eq!(
            reduce_colour(Color::Rgb(250, 10, 10), Depth::Ansi16),
            Color::LightRed
        );
        assert_eq!(
            reduce_colour(Color::Rgb(0, 190, 0), Depth::Ansi16),
            Color::Green
        );
        assert_eq!(reduce_colour(Color::Indexed(1), Depth::Ansi16), Color::Red);
        assert_eq!(
            reduce_colour(Color::Indexed(244), Depth::Ansi16),
            Color::DarkGray
        );
        assert_eq!(reduce_colour(Color::Cyan, Depth::Ansi16), Color::Cyan);
        assert_eq!(
            reduce_colour(Color::Indexed(200), Depth::Ansi256),
            Color::Indexed(200)
        );
        let mut buf = Buffer::empty(ratatui::layout::Rect::new(0, 0, 1, 1));
        buf.content[0].fg = Color::Rgb(255, 0, 0);
        reduce(&mut buf, Depth::Ansi256);
        assert_eq!(buf.content[0].fg, Color::Indexed(196));
    }
}
