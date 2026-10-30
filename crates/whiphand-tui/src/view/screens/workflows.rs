//! The workflows screen: the list on the left, the one selected (or the
//! draft that did not pass) on the right.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Cell, Paragraph, Row, Table, TableState, Wrap};
use whiphand_protocol::{Scope, WorkflowListEntry};

use crate::model::Model;
use crate::model::workflows::{WorkflowEdit, scope_word, step_lines, workflow};
use crate::view::theme;

pub fn render(model: &Model, frame: &mut Frame, area: Rect) {
    let [left, right] =
        Layout::horizontal([Constraint::Percentage(40), Constraint::Percentage(60)]).areas(area);
    render_list(model, frame, left);
    match &model.workflows.edit {
        Some(edit) if edit.checking || !edit.problems.is_empty() => {
            render_draft(edit, frame, right);
        }
        _ => render_preview(model, frame, right),
    }
}

fn render_list(model: &Model, frame: &mut Frame, area: Rect) {
    let ui = &model.workflows;
    let block = Block::bordered().title(" Workflows ");
    let Some(list) = &ui.list else {
        let p = Paragraph::new("Loading workflows…").style(theme::dim());
        frame.render_widget(p.block(block), area);
        return;
    };
    let [setup, table_area] = Layout::vertical([
        Constraint::Length(if ui.needs_setup() { 2 } else { 0 }),
        Constraint::Fill(1),
    ])
    .areas(block.inner(area));
    frame.render_widget(block, area);
    if ui.needs_setup() {
        frame.render_widget(
            Paragraph::new("This workspace has no workflows of its own: i sets it up.")
                .style(theme::waiting())
                .wrap(Wrap { trim: true }),
            setup,
        );
    }
    let rows = list.iter().map(|e| {
        let mark = match (&e.error, e.shadowed) {
            (Some(_), _) => Span::styled("✘", theme::error()),
            (None, Some(true)) => Span::styled("·", theme::dim()),
            _ => Span::raw(""),
        };
        let scope = match e.source {
            Scope::Project => Span::raw("project"),
            Scope::Workspace => Span::styled("workspace", theme::dim()),
            Scope::Global => Span::styled("global", theme::dim()),
        };
        Row::new(vec![
            Cell::from(mark),
            Cell::from(e.name.clone()),
            Cell::from(scope),
        ])
    });
    let table = Table::new(
        rows,
        [
            Constraint::Length(1),
            Constraint::Fill(1),
            Constraint::Length(9),
        ],
    )
    .row_highlight_style(theme::selected());
    let mut state = TableState::default().with_selected(Some(ui.selected));
    frame.render_stateful_widget(table, table_area, &mut state);
}

fn render_preview(model: &Model, frame: &mut Frame, area: Rect) {
    let Some(entry) = model.workflows.current() else {
        let block = Block::bordered();
        let text = if model.workflows.list.is_some() {
            "No workflows. n makes one in this workspace, N a global one."
        } else {
            ""
        };
        let p = Paragraph::new(text)
            .style(theme::dim())
            .wrap(Wrap { trim: true });
        frame.render_widget(p.block(block), area);
        return;
    };
    let block = Block::bordered().title(format!(" {} ", entry.name));
    frame.render_widget(
        Paragraph::new(preview_lines(entry))
            .wrap(Wrap { trim: false })
            .block(block),
        area,
    );
}

fn preview_lines(entry: &WorkflowListEntry) -> Vec<Line<'static>> {
    let mut lines = vec![Line::styled(
        format!("{} · {}", scope_word(entry.source), entry.path),
        theme::dim(),
    )];
    if entry.shadowed == Some(true) {
        lines.push(Line::styled(
            "A workflow of the same name in a higher scope is used instead.",
            theme::dim(),
        ));
    }
    if let Some(error) = &entry.error {
        lines.push(Line::default());
        lines.push(Line::styled("Does not parse:", theme::error()));
        lines.extend(
            error
                .lines()
                .map(|l| Line::styled(l.to_string(), theme::error())),
        );
        lines.push(Line::default());
        lines.push(Line::styled("e edits it to fix it.", theme::dim()));
        return lines;
    }
    let Some(wf) = workflow(entry) else {
        lines.push(Line::styled(
            "(no preview: the TUI could not read it)",
            theme::dim(),
        ));
        return lines;
    };
    if let Some(description) = &wf.description {
        lines.push(Line::default());
        lines.extend(description.lines().map(|l| Line::raw(l.to_string())));
    }
    if let Some(inputs) = wf.inputs.as_ref().filter(|i| !i.is_empty()) {
        lines.push(Line::default());
        lines.push(Line::styled("Inputs", theme::bold()));
        for (key, input) in inputs.iter() {
            let mut spans = vec![Span::raw(format!("  {key}"))];
            if input.required {
                spans.push(Span::styled("  required", theme::waiting()));
            }
            if let Some(d) = &input.default {
                spans.push(Span::styled(format!("  default {d}"), theme::dim()));
            }
            lines.push(Line::from(spans));
        }
    }
    lines.push(Line::default());
    lines.push(Line::styled("Steps", theme::bold()));
    lines.extend(
        step_lines(&wf.steps)
            .into_iter()
            .map(|l| Line::raw(format!("  {l}"))),
    );
    lines
}

fn render_draft(edit: &WorkflowEdit, frame: &mut Frame, area: Rect) {
    let block = Block::bordered().title(format!(" Editing {} ", edit.name));
    let mut lines = Vec::new();
    if edit.checking {
        lines.push(Line::styled("Checking the draft…", theme::dim()));
    } else {
        lines.push(Line::styled(
            "Not saved: the draft did not pass. The file is unchanged.",
            theme::error(),
        ));
        lines.push(Line::default());
        for problem in &edit.problems {
            lines.push(Line::raw(format!("• {problem}")));
        }
        lines.push(Line::default());
        lines.push(Line::styled(
            "e edits the draft again  ·  Esc drops it",
            theme::dim(),
        ));
    }
    lines.push(Line::default());
    lines.push(Line::styled(
        format!(
            "The file name is the workflow's name ({}); comments you add in the editor are not kept.",
            edit.name
        ),
        theme::dim(),
    ));
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .block(block),
        area,
    );
}
