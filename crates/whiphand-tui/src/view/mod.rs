//! `view(&Model, &mut Frame)`: rendering, pure. Only `runtime/` does I/O.

mod runs;

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::model::Model;

pub fn view(model: &Model, frame: &mut Frame) {
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .areas(frame.area());
    frame.render_widget(header_line(model), header);
    runs::render(model, frame, body);
    frame.render_widget(footer_line(model), footer);
}

fn header_line(model: &Model) -> Line<'_> {
    let dim = Style::new().add_modifier(Modifier::DIM);
    Line::from(vec![
        Span::styled("whiphand", Style::new().add_modifier(Modifier::BOLD)),
        Span::raw("  "),
        Span::raw(model.workdir.as_str()),
        Span::styled("  (experimental)", dim),
    ])
}

fn footer_line(model: &Model) -> Line<'_> {
    if let Some(fatal) = &model.fatal {
        return Line::styled(
            format!(" {fatal}  ·  q quit"),
            Style::new().fg(Color::White).bg(Color::Red),
        );
    }
    if model.confirm_quit {
        let n = model.live_jobs();
        let (runs, they) = if n == 1 {
            ("run", "it")
        } else {
            ("runs", "they")
        };
        return Line::styled(
            format!(
                " {n} {runs} in progress will be cancelled; {they} can be resumed. Quit? (y/n)"
            ),
            Style::new().fg(Color::Black).bg(Color::Yellow),
        );
    }
    if let Some(notice) = &model.notice {
        return Line::styled(format!(" {notice}"), Style::new().fg(Color::Red));
    }
    Line::styled(
        " j/k move  ·  q quit",
        Style::new().add_modifier(Modifier::DIM),
    )
}
