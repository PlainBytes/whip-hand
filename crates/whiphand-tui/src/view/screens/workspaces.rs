//! Recent and pinned workspaces.

use ratatui::Frame;
use ratatui::layout::{Constraint, Rect};
use ratatui::text::Span;
use ratatui::widgets::{Block, Cell, Paragraph, Row, Table, TableState};

use crate::model::Model;
use crate::view::theme;

pub fn render(model: &Model, frame: &mut Frame, area: Rect) {
    let ws = &model.workspaces;
    let block = Block::bordered().title(" Workspaces ");
    if ws.recents.is_empty() {
        let text = if ws.loaded {
            "No recent workspaces. Start with `whiphand tui -C <folder>` in a folder that has .whiphand/ \
             (`whiphand init` makes one)."
        } else {
            "Loading…"
        };
        frame.render_widget(
            Paragraph::new(text)
                .style(theme::dim())
                .wrap(ratatui::widgets::Wrap { trim: true })
                .block(block),
            area,
        );
        return;
    }
    let rows = ws.recents.iter().map(|w| {
        let current = model.workdir.as_deref() == Some(w.path.as_str());
        let pin = if w.pinned == Some(true) { "★" } else { "" };
        let mark = if current {
            Span::styled("●", theme::status("running"))
        } else {
            Span::raw("")
        };
        Row::new(vec![
            Cell::from(mark),
            Cell::from(pin),
            Cell::from(w.path.clone()),
            Cell::from(Span::styled(
                w.last_opened_at.get(..10).unwrap_or("").to_string(),
                theme::dim(),
            )),
        ])
    });
    let table = Table::new(
        rows,
        [
            Constraint::Length(1),
            Constraint::Length(2),
            Constraint::Fill(1),
            Constraint::Length(10),
        ],
    )
    .header(Row::new(["", "", "Path", "Opened"]).style(theme::bold()))
    .row_highlight_style(theme::selected())
    .block(block);
    let mut state = TableState::default().with_selected(Some(ws.selected));
    frame.render_stateful_widget(table, area, &mut state);
}
