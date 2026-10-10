//! The runs table: the home screen.

use ratatui::Frame;
use ratatui::layout::{Constraint, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Cell, Paragraph, Row, Table, TableState};

use crate::model::Model;
use crate::model::runs::Row as RunRow;
use crate::view::theme;

fn status_cell(row: &RunRow) -> Line<'static> {
    let mut spans = vec![Span::styled(row.status.clone(), theme::status(&row.status))];
    if row.waiting {
        spans.push(Span::styled(" · waiting", theme::waiting()));
    }
    if row.foreign {
        spans.push(Span::styled(" · foreign", theme::dim()));
    }
    Line::from(spans)
}

fn run_cell(row: &RunRow) -> String {
    let label = match &row.name {
        Some(name) => format!("{name} ({})", row.run_id),
        None => row.run_id.clone(),
    };
    if row.locked {
        format!("{label} [locked]")
    } else {
        label
    }
}

/// The last path segment: enough to tell workspaces apart in a column.
fn short_workspace(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_string()
}

fn title(model: &Model) -> String {
    let ui = &model.runs_ui;
    let mut title = if ui.ongoing {
        " Ongoing runs, every workspace ".to_string()
    } else {
        " Runs ".to_string()
    };
    if ui.editing || !ui.filter.is_empty() {
        let cursor = if ui.editing { "▏" } else { "" };
        title.push_str(&format!("· filter: {}{cursor} ", ui.filter));
    }
    title
}

pub fn render(model: &Model, frame: &mut Frame, area: Rect) {
    let rows = model.visible_rows();
    let block = Block::bordered().title(title(model));
    if rows.is_empty() {
        let text = if model.agent_version.is_none() {
            "Loading…"
        } else if !model.runs_ui.filter.is_empty() {
            "No run matches the filter."
        } else if model.runs_ui.ongoing {
            "Nothing is running in any recent workspace."
        } else {
            "No runs in this workspace yet."
        };
        frame.render_widget(Paragraph::new(text).style(theme::dim()).block(block), area);
        return;
    }
    let ongoing = model.runs_ui.ongoing;
    let table_rows = rows.iter().map(|r| {
        let mut cells = vec![
            Cell::from(r.workflow.clone()),
            Cell::from(run_cell(r)),
            Cell::from(status_cell(r)),
            Cell::from(r.step.clone()),
            Cell::from(r.elapsed.clone()),
        ];
        if ongoing {
            cells.insert(
                0,
                Cell::from(
                    r.workspace
                        .as_deref()
                        .map(short_workspace)
                        .unwrap_or_default(),
                ),
            );
        }
        // A foreign run is read-only here: dim the whole row.
        Row::new(cells).style(if r.foreign {
            theme::dim()
        } else {
            Default::default()
        })
    });
    let mut widths = vec![
        Constraint::Length(12),
        Constraint::Fill(1),
        Constraint::Length(19),
        Constraint::Length(12),
        Constraint::Length(7),
    ];
    let mut header = vec!["Workflow", "Run", "Status", "Step", "Elapsed"];
    if ongoing {
        widths.insert(0, Constraint::Length(14));
        header.insert(0, "Workspace");
    }
    let table = Table::new(table_rows, widths)
        .header(Row::new(header).style(theme::bold()))
        .row_highlight_style(theme::selected())
        .block(block);
    let mut state = TableState::default().with_selected(Some(model.runs_ui.selected));
    frame.render_stateful_widget(table, area, &mut state);
}
