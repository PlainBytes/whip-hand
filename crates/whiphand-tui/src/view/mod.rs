//! `view(&Model, &mut Frame)`: rendering, pure. Only `runtime/` does I/O.

pub mod keymap;
mod screens;
pub mod theme;
pub mod widgets;

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::text::{Line, Span};

use crate::model::{Model, Route};

pub fn view(model: &Model, frame: &mut Frame) {
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .areas(frame.area());
    frame.render_widget(header_line(model), header);
    match model.screen() {
        Route::Workspaces => screens::workspaces::render(model, frame, body),
        Route::Runs => screens::runs::render(model, frame, body),
        Route::RunDetail => screens::detail::render(model, frame, body),
        Route::Doctor => screens::doctor::render(model, frame, body),
    }
    frame.render_widget(footer_line(model), footer);
    if model.help {
        widgets::help::render(frame, body, model.screen());
    }
    if model.no_color {
        theme::strip_colour(frame.buffer_mut());
    }
}

fn header_line(model: &Model) -> Line<'_> {
    let mut spans = vec![
        Span::styled("whiphand", theme::bold()),
        Span::raw("  "),
        Span::raw(model.workdir.as_deref().unwrap_or("no workspace")),
        Span::styled(format!("  · {}", model.screen().title()), theme::dim()),
        Span::styled("  (experimental)", theme::dim()),
    ];
    if model.pending_g {
        spans.push(Span::styled("  g…", theme::waiting()));
    }
    Line::from(spans)
}

fn footer_line(model: &Model) -> Line<'_> {
    if let Some(fatal) = &model.fatal {
        return Line::styled(format!(" {fatal}  ·  q quit"), theme::fatal_bar());
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
            theme::warning_bar(),
        );
    }
    if let Some(notice) = &model.notice {
        return Line::styled(format!(" {notice}"), theme::error());
    }
    if let Some((toast, _)) = &model.toast {
        return Line::styled(format!(" {toast}"), theme::waiting());
    }
    if model.runs_ui.editing && *model.screen() == Route::Runs {
        return Line::styled(" type to filter  ·  Enter keep  ·  Esc clear", theme::dim());
    }
    Line::styled(format!(" {}", keymap::hints(model.screen())), theme::dim())
}
