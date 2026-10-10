//! A run's log rows, one line each, drawn bottom-anchored: only the rows
//! that fit are built, however long the log is.

use ansi_to_tui::IntoText;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};

use crate::model::log::LogEntry;
use crate::view::theme;

/// `HH:MM:SS` of an ISO stamp (UTC, as `run.log` writes it).
fn clock(ts: &str) -> &str {
    ts.get(11..19).unwrap_or(ts)
}

fn kind_style(e: &LogEntry) -> Style {
    if e.is_error() {
        return theme::error();
    }
    match e.row.kind.as_str() {
        "step:start" | "step:done" | "run:start" | "run:resume" | "run:done" => theme::bold(),
        k if k.starts_with("step:progress") => theme::dim(),
        "session:await" => theme::waiting(),
        "run:cancelled" | "guard:warning" | "run:degraded" => Style::new().fg(Color::Yellow),
        _ => Style::new(),
    }
}

/// A step's own output keeps its colours; everything else is plain text.
fn text_spans(e: &LogEntry, style: Style) -> Vec<Span<'static>> {
    let text = e.row.text.replace('\n', " ⏎ ");
    if e.row.kind == "step:log"
        && text.contains('\x1b')
        && let Ok(parsed) = text.as_bytes().into_text()
        && let Some(line) = parsed.lines.into_iter().next()
    {
        return line
            .spans
            .into_iter()
            .map(|s| Span::styled(s.content.into_owned(), style.patch(s.style)))
            .collect();
    }
    vec![Span::styled(text, style)]
}

fn line(e: &LogEntry, with_kind: bool) -> Line<'static> {
    let style = kind_style(e);
    let mut spans = vec![Span::styled(format!("{} ", clock(&e.ts)), theme::dim())];
    if with_kind {
        spans.push(Span::styled(format!("{:<20} ", e.row.kind), style));
    }
    let step = e.row.step_id.as_deref().unwrap_or("-");
    spans.push(Span::styled(format!("{step:<14} "), theme::dim()));
    spans.extend(text_spans(e, if with_kind { Style::new() } else { style }));
    Line::from(spans)
}

/// The `height` rows that end `scroll` rows above the newest.
pub fn lines(
    rows: &[&LogEntry],
    scroll: usize,
    height: usize,
    with_kind: bool,
) -> Vec<Line<'static>> {
    let end = rows
        .len()
        .saturating_sub(scroll)
        .max(height.min(rows.len()));
    let start = end.saturating_sub(height);
    rows[start..end]
        .iter()
        .map(|e| line(e, with_kind))
        .collect()
}
