//! Colours and glyphs, in one place. `NO_COLOR` is honoured once, after the
//! frame is drawn ([`strip_colour`]), so nothing here has to ask.

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
