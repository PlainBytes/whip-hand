//! `view(&Model, &mut Frame)`: rendering, pure. Only `runtime/` does I/O.

pub mod keymap;
mod screens;
pub mod theme;
pub mod widgets;

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::text::{Line, Span};

use crate::model::{Dialog, Model, Route};

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
        Route::NewRun => screens::new_run::render(model, frame, body),
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
    match &model.dialog {
        Some(Dialog::Confirm { question, .. }) => {
            return Line::styled(format!(" {question}"), theme::warning_bar());
        }
        Some(Dialog::Prompt { label, input, .. }) => {
            let text = input.text();
            let at = text
                .char_indices()
                .nth(input.cursor().1)
                .map_or(text.len(), |(i, _)| i);
            let (before, after) = text.split_at(at);
            return Line::from(vec![
                Span::styled(format!(" {label}: "), theme::warning_bar()),
                Span::raw(before.to_string()),
                Span::styled("▏", theme::bold()),
                Span::raw(after.to_string()),
                Span::styled("  Enter ok  ·  Esc cancel", theme::dim()),
            ]);
        }
        None => {}
    }
    if let Some(notice) = &model.notice {
        return Line::styled(format!(" {notice}"), theme::error());
    }
    if let Some((toast, _)) = &model.toast {
        return Line::styled(format!(" {toast}"), theme::waiting());
    }
    if let Some(hints) = screens::new_run::editing_hints(model) {
        return Line::styled(format!(" {hints}"), theme::dim());
    }
    if model.runs_ui.editing && *model.screen() == Route::Runs {
        return Line::styled(" type to filter  ·  Enter keep  ·  Esc clear", theme::dim());
    }
    Line::styled(format!(" {}", keymap::hints(model.screen())), theme::dim())
}
