//! The new-run screen: the workflow picker, then the workflow's form.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph, Wrap};
use whiphand_protocol::{Scope, WorkflowListEntry};

use crate::model::Model;
use crate::model::input::Input;
use crate::model::new_run::{Field, FieldKind, Form, NewRun};
use crate::view::theme;

const LABEL: usize = 16;
/// Lines a long field shows when it is not being edited.
const FOLDED: usize = 3;

fn scope(entry: &WorkflowListEntry) -> &'static str {
    match entry.source {
        Scope::Global => " (global)",
        Scope::Project => "",
    }
}

fn busy_warning(n: &NewRun) -> Option<Line<'static>> {
    n.workspace_busy.then(|| {
        Line::styled(
            " Another run is already in progress in this workspace.",
            theme::waiting(),
        )
    })
}

pub fn render(model: &Model, frame: &mut Frame, area: Rect) {
    let Some(n) = &model.new_run else {
        return;
    };
    match &n.form {
        Some(form) => render_form(n, form, frame, area),
        None => render_picker(n, frame, area),
    }
}

fn render_picker(n: &NewRun, frame: &mut Frame, area: Rect) {
    let block = Block::bordered().title(" New run · pick a workflow ");
    let Some(list) = &n.workflows else {
        let p = Paragraph::new("Loading workflows…").style(theme::dim());
        frame.render_widget(p.block(block), area);
        return;
    };
    let mut lines: Vec<Line> = busy_warning(n).into_iter().collect();
    if list.is_empty() {
        lines.push(Line::styled(
            "No workflows here yet: `whiphand init` sets the workspace up.",
            theme::dim(),
        ));
    }
    let first = lines.len();
    for (i, entry) in list.iter().enumerate() {
        let mut spans = vec![Span::raw(format!(" {}{}", entry.name, scope(entry)))];
        if entry.shadowed == Some(true) {
            spans.push(Span::styled(
                "  shadowed by a project workflow",
                theme::dim(),
            ));
        }
        if let Some(error) = &entry.error {
            spans.push(Span::styled(
                format!("  does not parse: {error}"),
                theme::error(),
            ));
        } else if let Some(d) = entry
            .workflow
            .as_ref()
            .and_then(|w| w.get("description"))
            .and_then(|d| d.as_str())
        {
            spans.push(Span::styled(
                format!("  {}", d.lines().next().unwrap_or("")),
                theme::dim(),
            ));
        }
        let mut line = Line::from(spans);
        if i == n.cursor {
            line = line.style(theme::selected());
        }
        lines.push(line);
    }
    let height = usize::from(area.height.saturating_sub(2));
    let scroll = (first + n.cursor + 1).saturating_sub(height);
    let p = Paragraph::new(lines)
        .scroll((scroll as u16, 0))
        .block(block);
    frame.render_widget(p, area);
}

/// The text with the cursor drawn in, when it is being edited.
fn text_lines(input: &Input, editing: bool) -> Vec<Line<'static>> {
    let (row, col) = input.cursor();
    let lines = input.lines();
    let shown: Box<dyn Iterator<Item = (usize, &String)>> = if editing {
        Box::new(lines.iter().enumerate())
    } else {
        Box::new(lines.iter().enumerate().take(FOLDED))
    };
    let mut out: Vec<Line> = shown
        .map(|(i, l)| {
            if editing && i == row {
                let at = l.char_indices().nth(col).map_or(l.len(), |(b, _)| b);
                Line::from(vec![
                    Span::raw(l[..at].to_string()),
                    Span::styled("▏", theme::bold()),
                    Span::raw(l[at..].to_string()),
                ])
            } else {
                Line::raw(l.clone())
            }
        })
        .collect();
    if !editing && lines.len() > FOLDED {
        out.push(Line::styled(
            format!("… {} more lines", lines.len() - FOLDED),
            theme::dim(),
        ));
    }
    out
}

fn field_lines(form: &Form, i: usize, field: &Field) -> Vec<Line<'static>> {
    let focused = i == form.focus;
    let label_style = if focused {
        theme::selected()
    } else {
        theme::bold()
    };
    let label = match &field.kind {
        FieldKind::Input { required: true, .. } => format!("{}*", field.label()),
        _ => field.label().to_string(),
    };
    let label = Span::styled(format!(" {label:<LABEL$}"), label_style);
    let toggle = |on: bool, what: &str| {
        let mark = if on { "[x]" } else { "[ ]" };
        vec![Line::from(vec![
            label.clone(),
            Span::raw(format!("{mark} {what}")),
        ])]
    };
    match &field.kind {
        FieldKind::DryRun => toggle(form.dry_run, "resolve every step without running it"),
        FieldKind::Worktree => toggle(
            form.worktree,
            "changes land on a new branch in .whiphand/worktrees/",
        ),
        FieldKind::Start => {
            let style = if focused {
                theme::selected()
            } else {
                theme::bold()
            };
            vec![Line::from(vec![
                Span::raw(format!(" {:<LABEL$}", "")),
                Span::styled("[ Start run ]", style),
            ])]
        }
        kind => {
            let editing = focused && form.editing;
            let mut body = text_lines(&field.input, editing);
            if !editing && field.input.is_blank() {
                let hint = match kind {
                    FieldKind::Input { prompt, .. } => prompt.clone().unwrap_or_default(),
                    FieldKind::Name => "optional".into(),
                    FieldKind::MaxIterations => "the workflow's own budgets".into(),
                    FieldKind::Attachments => "file paths, one per line".into(),
                    _ => String::new(),
                };
                body = vec![Line::styled(hint, theme::dim())];
            }
            let indent = " ".repeat(LABEL + 1);
            body.into_iter()
                .enumerate()
                .map(|(j, line)| {
                    let mut spans = vec![if j == 0 {
                        label.clone()
                    } else {
                        Span::raw(indent.clone())
                    }];
                    spans.extend(line.spans);
                    Line::from(spans)
                })
                .collect()
        }
    }
}

fn render_form(n: &NewRun, form: &Form, frame: &mut Frame, area: Rect) {
    let title = format!(" New run · {}{} ", form.entry.name, scope(&form.entry));
    let block = Block::bordered().title(title);
    let mut lines: Vec<Line> = Vec::new();
    if let Some(d) = &form.description {
        lines.extend(
            d.lines()
                .map(|l| Line::styled(format!(" {l}"), theme::dim())),
        );
    }
    lines.extend(busy_warning(n));
    if let Some((names, consequences)) = &form.disabled {
        lines.push(Line::styled(
            format!(" Disabled: {}.", names.join(", ")),
            theme::waiting(),
        ));
        lines.extend(
            consequences
                .iter()
                .map(|c| Line::styled(format!(" {c}"), theme::waiting())),
        );
    }
    if let Some(error) = &form.error {
        lines.push(Line::styled(format!(" {error}"), theme::error()));
    }
    if n.starting || n.job_id.is_some() {
        lines.push(Line::styled(" Starting…", theme::dim()));
    }
    lines.push(Line::raw(""));
    let mut focus_line = 0;
    for (i, field) in form.fields.iter().enumerate() {
        if i == form.focus {
            focus_line = lines.len();
        }
        lines.extend(field_lines(form, i, field));
    }
    let height = usize::from(area.height.saturating_sub(2));
    let scroll = (focus_line + 4).saturating_sub(height);
    let p = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((scroll as u16, 0))
        .block(block);
    frame.render_widget(p, area);
}

/// The footer while a field is being edited.
pub fn editing_hints(model: &Model) -> Option<&'static str> {
    let form = model.new_run.as_ref()?.form.as_ref()?;
    if !form.editing {
        return None;
    }
    Some(if form.fields[form.focus].input.multiline {
        "Enter new line  ·  Esc done  ·  Ctrl-e $EDITOR"
    } else {
        "Enter next  ·  Esc done  ·  Ctrl-e $EDITOR"
    })
}
