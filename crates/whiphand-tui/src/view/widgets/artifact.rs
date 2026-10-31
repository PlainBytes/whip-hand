//! One artifact: its name and hints on a title line, its body below.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Paragraph, Wrap};
use whiphand_core::format::format_bytes;

use crate::model::detail::{ArtifactBody, ArtifactView};
use crate::view::theme;
use crate::view::widgets::markdown;

/// `back` is the key that leaves the artifact, as the hint spells it.
pub fn render(view: &ArtifactView, back: &str, frame: &mut Frame, area: Rect) {
    let [title, body] = Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(area);
    frame.render_widget(
        Line::from(vec![
            Span::styled(view.name.clone(), theme::bold()),
            Span::styled(
                match view.body {
                    ArtifactBody::Text(_) => format!("  e edit · o pager · {back} back"),
                    _ => format!("  o pager · {back} back"),
                },
                theme::dim(),
            ),
        ]),
        title,
    );
    let text: Text = match &view.body {
        ArtifactBody::Loading => Text::styled("Loading…", theme::dim()),
        ArtifactBody::Text(t) if view.name.ends_with(".md") => markdown::render(t),
        ArtifactBody::Text(t) => Text::raw(t.replace('\t', "    ")),
        ArtifactBody::TooLarge(n) => Text::styled(
            format!(
                "{} — too large to show here; o opens it in $PAGER",
                format_bytes(*n as f64)
            ),
            theme::dim(),
        ),
        ArtifactBody::Binary(n) => Text::styled(
            format!("binary, {}; o opens it in $PAGER", format_bytes(*n as f64)),
            theme::dim(),
        ),
        ArtifactBody::Failed(e) => Text::styled(e.clone(), theme::error()),
    };
    frame.render_widget(
        Paragraph::new(text)
            .wrap(Wrap { trim: false })
            .scroll((view.scroll, 0)),
        body,
    );
}
