//! `whiphand doctor`, as the CLI prints it.

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::{Block, Paragraph};

use crate::model::Model;
use crate::update::doctor_text;
use crate::view::theme;

pub fn render(model: &Model, frame: &mut Frame, area: Rect) {
    let block = Block::bordered().title(" Doctor ");
    let Some(rows) = &model.doctor.rows else {
        frame.render_widget(
            Paragraph::new("Checking tools…")
                .style(theme::dim())
                .block(block),
            area,
        );
        return;
    };
    let lines: Vec<Line> = doctor_text(rows)
        .lines()
        .map(|l| {
            let style = match l.chars().next() {
                Some('✔') => theme::status("done"),
                Some('✘') => theme::error(),
                Some('○') | Some(' ') => theme::dim(),
                _ => theme::bold(),
            };
            Line::styled(l.to_string(), style)
        })
        .collect();
    frame.render_widget(
        Paragraph::new(lines)
            .scroll((model.doctor.scroll, 0))
            .block(block),
        area,
    );
}
