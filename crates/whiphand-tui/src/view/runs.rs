//! The runs table: the home screen.

use ratatui::Frame;
use ratatui::layout::{Constraint, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Cell, Paragraph, Row, Table, TableState};

use crate::model::Model;
use crate::model::runs::Row as RunRow;

fn status_style(status: &str) -> Style {
    match status {
        "running" => Style::new().fg(Color::Cyan),
        "succeeded" => Style::new().fg(Color::Green),
        "failed" | "interrupted" => Style::new().fg(Color::Red),
        "cancelled" => Style::new().fg(Color::Yellow),
        _ => Style::new(),
    }
}

fn status_cell(row: &RunRow) -> Line<'static> {
    let mut spans = vec![Span::styled(row.status.clone(), status_style(&row.status))];
    if row.waiting {
        spans.push(Span::styled(
            " · waiting",
            Style::new().fg(Color::Magenta).add_modifier(Modifier::BOLD),
        ));
    }
    if row.foreign {
        spans.push(Span::styled(
            " · foreign",
            Style::new().add_modifier(Modifier::DIM),
        ));
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

pub fn render(model: &Model, frame: &mut Frame, area: Rect) {
    let rows = model.rows();
    let block = Block::bordered().title(" Runs ");
    if rows.is_empty() {
        let text = if model.agent_version.is_some() {
            "No runs in this workspace yet."
        } else {
            "Loading…"
        };
        frame.render_widget(
            Paragraph::new(text)
                .style(Style::new().add_modifier(Modifier::DIM))
                .block(block),
            area,
        );
        return;
    }
    let table_rows = rows.iter().map(|r| {
        // A foreign run is read-only here: dim the whole row.
        let style = if r.foreign {
            Style::new().add_modifier(Modifier::DIM)
        } else {
            Style::new()
        };
        Row::new(vec![
            Cell::from(r.workflow.clone()),
            Cell::from(run_cell(r)),
            Cell::from(status_cell(r)),
            Cell::from(r.step.clone()),
            Cell::from(r.elapsed.clone()),
        ])
        .style(style)
    });
    let table = Table::new(
        table_rows,
        [
            Constraint::Length(12),
            Constraint::Fill(1),
            Constraint::Length(19),
            Constraint::Length(12),
            Constraint::Length(7),
        ],
    )
    .header(
        Row::new(["Workflow", "Run", "Status", "Step", "Elapsed"])
            .style(Style::new().add_modifier(Modifier::BOLD)),
    )
    .row_highlight_style(Style::new().add_modifier(Modifier::REVERSED))
    .block(block);
    let mut state = TableState::default().with_selected(Some(model.selected));
    frame.render_stateful_widget(table, area, &mut state);
}
