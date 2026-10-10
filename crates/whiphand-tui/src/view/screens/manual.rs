//! A manual or approval step: its instructions (or the focused file's
//! patch) above; the note, the artifacts and the changed files below; the
//! choices last.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Paragraph, Wrap};

use crate::model::Model;
use crate::model::detail::DiffState;
use crate::model::input::Input;
use crate::model::manual::{Focus, Manual, choice_key};
use crate::view::theme;
use crate::view::widgets::{diff, markdown};

/// Lines a note or a comment shows when it is not being edited.
const FOLDED: usize = 2;

fn input_lines(input: &Input, editing: bool, indent: &str) -> Vec<Line<'static>> {
    let (row, col) = input.cursor();
    let lines = input.lines();
    let take = if editing { lines.len() } else { FOLDED };
    let mut out: Vec<Line> = lines
        .iter()
        .take(take)
        .enumerate()
        .map(|(i, l)| {
            let mut spans = vec![Span::raw(indent.to_string())];
            if editing && i == row {
                let at = l.char_indices().nth(col).map_or(l.len(), |(b, _)| b);
                spans.push(Span::raw(l[..at].to_string()));
                spans.push(Span::styled("▏", theme::bold()));
                spans.push(Span::raw(l[at..].to_string()));
            } else {
                spans.push(Span::raw(l.clone()));
            }
            Line::from(spans)
        })
        .collect();
    if lines.len() > take {
        out.push(Line::styled(
            format!("{indent}… {} more lines", lines.len() - take),
            theme::dim(),
        ));
    }
    out
}

fn marker(m: &Manual, focus: Focus) -> Span<'static> {
    if m.focus == focus {
        Span::styled("▸ ", theme::bold())
    } else {
        Span::raw("  ")
    }
}

/// The lower list, and the line the focus is on.
fn list_lines(m: &Manual) -> (Vec<Line<'static>>, usize) {
    let mut lines = Vec::new();
    let mut focus_line = 0;
    let label = m
        .request
        .capture
        .as_ref()
        .map_or("Note", |c| c.label.as_str());
    let required = m
        .request
        .capture
        .as_ref()
        .is_some_and(|c| !c.required_for.is_empty());
    if m.focus == Focus::Note {
        focus_line = lines.len();
    }
    let star = if required { "*" } else { "" };
    lines.push(Line::from(vec![
        marker(m, Focus::Note),
        Span::styled(format!("{label}{star}"), theme::bold()),
    ]));
    let editing_note = m.editing && m.focus == Focus::Note;
    if m.note.is_blank() && !editing_note {
        lines.push(Line::styled("    i to write it", theme::dim()));
    } else {
        lines.extend(input_lines(&m.note, editing_note, "    "));
    }
    let artifacts = &m.request.context.artifacts;
    if !artifacts.is_empty() {
        lines.push(Line::styled("  Artifacts (Enter pages one)", theme::bold()));
    }
    for (i, a) in artifacts.iter().enumerate() {
        if m.focus == Focus::Artifact(i) {
            focus_line = lines.len();
        }
        lines.push(Line::from(vec![
            marker(m, Focus::Artifact(i)),
            Span::raw(format!("{}  ", a.id)),
            Span::styled(a.path.clone(), theme::dim()),
        ]));
    }
    if let Some(why) = &m.request.context.diff_unavailable {
        lines.push(Line::styled(format!("  No diff: {why}"), theme::dim()));
    }
    match &m.diff {
        None => {}
        Some(DiffState::Loading) => lines.push(Line::styled("  Changes: loading…", theme::dim())),
        Some(DiffState::Failed(e)) => {
            lines.push(Line::styled(format!("  Changes: {e}"), theme::error()))
        }
        Some(DiffState::Loaded(None)) => {
            lines.push(Line::styled(
                "  Changes: not a git repository",
                theme::dim(),
            ));
        }
        Some(DiffState::Loaded(Some(d))) => {
            let per_file = m.request.capture.as_ref().is_some_and(|c| c.per_file);
            let hint = if per_file {
                " (Enter comments on one)"
            } else {
                ""
            };
            lines.push(Line::styled(format!("  Changes{hint}"), theme::bold()));
            for (i, file) in diff::file_lines(d).into_iter().enumerate() {
                let Some(f) = d.files.get(i) else {
                    lines.push(file);
                    continue;
                };
                if m.focus == Focus::File(i) {
                    focus_line = lines.len();
                }
                let mut spans = vec![marker(m, Focus::File(i))];
                spans.extend(file.spans);
                let comment = m.comment(&f.path);
                if comment.is_some_and(|c| !c.is_blank()) {
                    spans.push(Span::styled("  ✎", theme::waiting()));
                }
                lines.push(Line::from(spans));
                let editing = m.editing && m.focus == Focus::File(i);
                if let Some(c) = comment.filter(|c| editing || !c.is_blank()) {
                    lines.extend(input_lines(c, editing, "      "));
                }
            }
        }
    }
    (lines, focus_line)
}

fn choices_line(m: &Manual) -> Line<'static> {
    if let Some(choice) = m.sent {
        return Line::styled(
            format!(" Sending: {}…", m.request.choice_label(choice)),
            theme::dim(),
        );
    }
    let mut spans = vec![Span::raw(" ")];
    for (i, &choice) in m.request.choices.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled("  ·  ", theme::dim()));
        }
        let style = if m.blocked(choice).is_some() {
            theme::dim()
        } else {
            theme::bold()
        };
        spans.push(Span::styled(
            format!("{} {}", choice_key(choice), m.request.choice_label(choice)),
            style,
        ));
    }
    Line::from(spans)
}

pub fn render(model: &Model, frame: &mut Frame, area: Rect) {
    let Some(m) = &model.manual else {
        return;
    };
    let title = format!(" {} · {} ", m.request.badge(), m.request.title);
    let block = Block::bordered().title(title);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let (list, focus_line) = list_lines(m);
    let list_height = (list.len() as u16).min(inner.height / 2).max(3);
    let [subtitle, top, rule, bottom, choices] = Layout::vertical([
        Constraint::Length(u16::from(m.request.subtitle().is_some())),
        Constraint::Min(3),
        Constraint::Length(1),
        Constraint::Length(list_height),
        Constraint::Length(1),
    ])
    .areas(inner);
    if let Some(s) = m.request.subtitle() {
        frame.render_widget(Line::styled(format!(" {s}"), theme::dim()), subtitle);
    }
    let body: Text = match m.focus {
        Focus::File(i) => match m.files().get(i) {
            Some(f) => Text::from(diff::patch_lines(f)),
            None => Text::default(),
        },
        _ => markdown::render(&m.request.instructions),
    };
    frame.render_widget(
        Paragraph::new(body)
            .wrap(Wrap { trim: false })
            .scroll((m.scroll, 0)),
        top,
    );
    frame.render_widget(
        Line::styled("─".repeat(usize::from(rule.width)), theme::dim()),
        rule,
    );
    let scroll = (focus_line + 2).saturating_sub(usize::from(list_height));
    frame.render_widget(Paragraph::new(list).scroll((scroll as u16, 0)), bottom);
    frame.render_widget(choices_line(m), choices);
}

/// The footer while the note or a comment is being written.
pub fn editing_hints(model: &Model) -> Option<&'static str> {
    model
        .manual
        .as_ref()
        .filter(|m| m.editing)
        .map(|_| "Enter new line  ·  Esc done  ·  Ctrl-e $EDITOR")
}
