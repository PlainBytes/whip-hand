//! A working diff: the files it touches, then the selected file's patch.

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use whiphand_protocol::{DiffStatus, WorkingDiff, WorkingDiffFile};

use crate::view::theme;

fn status_mark(s: DiffStatus) -> (&'static str, Style) {
    match s {
        DiffStatus::Added => ("A", Style::new().fg(Color::Green)),
        DiffStatus::Modified => ("M", Style::new().fg(Color::Yellow)),
        DiffStatus::Deleted => ("D", Style::new().fg(Color::Red)),
        DiffStatus::Renamed => ("R", Style::new().fg(Color::Cyan)),
    }
}

pub fn file_lines(diff: &WorkingDiff) -> Vec<Line<'static>> {
    let mut lines: Vec<Line> = diff
        .files
        .iter()
        .map(|f| {
            let (mark, style) = status_mark(f.status);
            let name = match &f.old_path {
                Some(old) => format!("{old} → {}", f.path),
                None => f.path.clone(),
            };
            let mut spans = vec![
                Span::styled(format!("{mark} "), style),
                Span::raw(name),
                Span::styled(format!("  +{}", f.additions), Style::new().fg(Color::Green)),
                Span::styled(format!(" -{}", f.deletions), Style::new().fg(Color::Red)),
            ];
            if f.binary {
                spans.push(Span::styled("  binary", theme::dim()));
            }
            Line::from(spans)
        })
        .collect();
    if let Some(n) = diff.files_truncated {
        lines.push(Line::styled(format!("… and {n} more files"), theme::dim()));
    }
    lines
}

pub fn patch_lines(file: &WorkingDiffFile) -> Vec<Line<'static>> {
    let Some(patch) = &file.patch else {
        let why = if file.binary {
            "binary file"
        } else {
            "no patch (too large to show; D for git diff)"
        };
        return vec![Line::styled(why, theme::dim())];
    };
    let mut lines: Vec<Line> = patch
        .lines()
        .map(|l| {
            let style = if l.starts_with("@@") {
                Style::new().fg(Color::Cyan)
            } else if l.starts_with('+') && !l.starts_with("+++") {
                Style::new().fg(Color::Green)
            } else if l.starts_with('-') && !l.starts_with("---") {
                Style::new().fg(Color::Red)
            } else if l.starts_with("diff ")
                || l.starts_with("index ")
                || l.starts_with("+++")
                || l.starts_with("---")
            {
                theme::bold()
            } else {
                Style::new()
            };
            Line::styled(l.replace('\t', "    "), style)
        })
        .collect();
    if file.truncated == Some(true) {
        lines.push(Line::styled(
            "… patch truncated; D for git diff",
            theme::dim(),
        ));
    }
    lines
}
