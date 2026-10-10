//! The `?` overlay, drawn from the keymap table.

use ratatui::Frame;
use ratatui::layout::{Constraint, Flex, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Paragraph};

use crate::model::Route;
use crate::view::keymap::{BINDINGS, Ctx};
use crate::view::theme;

pub fn render(frame: &mut Frame, area: Rect, screen: &Route) {
    let mut lines = Vec::new();
    for ctx in [Ctx::of(screen), Ctx::Global, Ctx::Goto] {
        lines.push(Line::styled(ctx.title(), theme::bold()));
        for b in BINDINGS.iter().filter(|b| b.ctx == ctx) {
            lines.push(Line::from(vec![
                Span::styled(format!("  {:<14}", b.label), theme::bold()),
                Span::raw(b.help),
            ]));
        }
        lines.push(Line::default());
    }
    lines.push(Line::styled("any key closes this", theme::dim()));
    let height = (lines.len() as u16 + 2).min(area.height);
    let width = 64.min(area.width);
    let [row] = Layout::vertical([Constraint::Length(height)])
        .flex(Flex::Center)
        .areas(area);
    let [popup] = Layout::horizontal([Constraint::Length(width)])
        .flex(Flex::Center)
        .areas(row);
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Paragraph::new(lines).block(Block::bordered().title(" Keys ")),
        popup,
    );
}
