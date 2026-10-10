//! One run: the step tree beside its log, events, artifacts and diff.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, List, ListState, Paragraph, Tabs, Wrap};
use whiphand_core::format::format_bytes;
use whiphand_core::run_tree::stage_stop_sentence;

use crate::model::Model;
use crate::model::detail::{ArtifactBody, ArtifactView, DiffState, Pane, RunDetail, Tab};
use crate::model::runs::row;
use crate::update::detail::is_foreign;
use crate::view::theme;
use crate::view::widgets::{diff, log, markdown, tree};

/// Below this width the tree goes above the tabs instead of beside them.
const SIDE_BY_SIDE: u16 = 100;

fn pane_block(title: Option<String>, focused: bool) -> Block<'static> {
    let block = match title {
        Some(t) => Block::bordered().title(t),
        None => Block::bordered(),
    };
    if focused {
        block.border_style(theme::bold())
    } else {
        block.border_style(theme::dim())
    }
}

fn header(model: &Model, d: &RunDetail) -> Text<'static> {
    let Some(manifest) = &d.manifest else {
        return Text::from(Line::from(vec![
            Span::styled(d.run_id.clone(), theme::bold()),
            Span::styled("  loading…", theme::dim()),
        ]));
    };
    let job = model.job_for(&d.run_id).map(|(_, j)| j);
    let r = row(manifest, job, model.now_ms);
    let mut first = vec![Span::styled(
        r.name.clone().unwrap_or_else(|| r.run_id.clone()),
        theme::bold(),
    )];
    if r.name.is_some() {
        first.push(Span::styled(format!(" ({})", r.run_id), theme::dim()));
    }
    first.push(Span::raw(format!("  {}  ", r.workflow)));
    first.push(Span::styled(r.status.clone(), theme::status(&r.status)));
    first.push(Span::raw(format!("  {}", r.elapsed)));
    if r.waiting {
        first.push(Span::styled("  waiting on you", theme::waiting()));
    }
    if let Some(branch) = manifest
        .pointer("/worktree/branch")
        .and_then(|b| b.as_str())
    {
        first.push(Span::styled(format!("  ⎇ {branch}"), theme::dim()));
    }
    if r.locked {
        first.push(Span::styled("  [locked]", theme::dim()));
    }
    let mut second = Vec::new();
    if is_foreign(model) {
        second.push(Span::styled(
            "owned by another whiphand process: read-only, refreshed every second",
            theme::warning_bar(),
        ));
    } else if let Some(stop) = stage_stop_sentence(&d.steps).filter(|_| r.status != "running") {
        second.push(Span::styled(stop, theme::error()));
    }
    Text::from(vec![Line::from(first), Line::from(second)])
}

pub fn render(model: &Model, frame: &mut Frame, area: Rect) {
    let Some(d) = &model.detail else {
        return;
    };
    let [head, body] = Layout::vertical([Constraint::Length(2), Constraint::Min(0)]).areas(area);
    frame.render_widget(Paragraph::new(header(model, d)), head);
    let (tree_area, tabs_area) = if body.width >= SIDE_BY_SIDE {
        let [t, r] =
            Layout::horizontal([Constraint::Percentage(36), Constraint::Min(0)]).areas(body);
        (t, r)
    } else {
        let lines = d.tree_lines().len() as u16 + 2;
        let [t, r] = Layout::vertical([
            Constraint::Max(lines.min(body.height * 2 / 5)),
            Constraint::Min(0),
        ])
        .areas(body);
        (t, r)
    };
    render_tree(model, d, frame, tree_area);
    render_tabs(d, frame, tabs_area);
}

fn render_tree(model: &Model, d: &RunDetail, frame: &mut Frame, area: Rect) {
    let focused = d.pane == Pane::Tree;
    let block = pane_block(Some(" Steps ".into()), focused);
    let lines = tree::lines(d, model.now_ms);
    if lines.is_empty() {
        frame.render_widget(
            Paragraph::new("No steps recorded yet.")
                .style(theme::dim())
                .block(block),
            area,
        );
        return;
    }
    let highlight = if focused {
        theme::selected()
    } else {
        theme::bold()
    };
    let list = List::new(lines).block(block).highlight_style(highlight);
    let mut state = ListState::default().with_selected(Some(d.tree_cursor));
    frame.render_stateful_widget(list, area, &mut state);
}

fn tab_title(d: &RunDetail) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(step) = &d.filter_step {
        parts.push(format!("step {step}"));
    }
    if d.errors_only && matches!(d.tab, Tab::Log | Tab::Events) {
        parts.push("errors only".into());
    }
    (!parts.is_empty()).then(|| format!(" {} ", parts.join(" · ")))
}

fn render_tabs(d: &RunDetail, frame: &mut Frame, area: Rect) {
    let focused = d.pane == Pane::Tabs;
    let block = pane_block(tab_title(d), focused);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let [bar, content] = Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(inner);
    let titles = Tab::ALL
        .iter()
        .enumerate()
        .map(|(i, t)| format!("{} {}", i + 1, t.title()));
    let selected = Tab::ALL.iter().position(|t| *t == d.tab).unwrap_or(0);
    frame.render_widget(
        Tabs::new(titles)
            .select(selected)
            .highlight_style(theme::selected()),
        bar,
    );
    match d.tab {
        Tab::Log | Tab::Events => render_log(d, frame, content),
        Tab::Artifacts => render_artifacts(d, frame, content),
        Tab::Diff => render_diff(d, frame, content),
    }
}

fn render_log(d: &RunDetail, frame: &mut Frame, area: Rect) {
    let rows = d.visible_log();
    if rows.is_empty() {
        let text = if !d.log.loaded {
            "Loading the log…"
        } else {
            "Nothing logged here yet."
        };
        frame.render_widget(Paragraph::new(text).style(theme::dim()), area);
        return;
    }
    let mut height = usize::from(area.height);
    let mut lines = Vec::new();
    let at_top = d.log_scroll + height >= rows.len();
    if at_top && (!d.log.at_start || d.loading_earlier) && height > 1 {
        lines.push(Line::styled(
            if d.loading_earlier {
                "loading earlier lines…"
            } else {
                "earlier lines in run.log: scroll up"
            },
            theme::dim(),
        ));
        height -= 1;
    }
    lines.extend(log::lines(
        &rows,
        d.log_scroll,
        height,
        d.tab == Tab::Events,
    ));
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_artifacts(d: &RunDetail, frame: &mut Frame, area: Rect) {
    if let Some(view) = &d.artifact_view {
        render_artifact(view, frame, area);
        return;
    }
    if d.artifacts.is_empty() {
        frame.render_widget(
            Paragraph::new("No artifacts yet.").style(theme::dim()),
            area,
        );
        return;
    }
    let items: Vec<Line> = d
        .artifacts
        .iter()
        .map(|(name, _)| Line::raw(name.clone()))
        .collect();
    let list = List::new(items).highlight_style(theme::selected());
    let mut state = ListState::default().with_selected(Some(d.artifact_cursor));
    frame.render_stateful_widget(list, area, &mut state);
}

fn render_artifact(view: &ArtifactView, frame: &mut Frame, area: Rect) {
    let [title, body] = Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(area);
    frame.render_widget(
        Line::from(vec![
            Span::styled(view.name.clone(), theme::bold()),
            Span::styled("  o pager · q back", theme::dim()),
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

fn render_diff(d: &RunDetail, frame: &mut Frame, area: Rect) {
    let diff = match &d.diff {
        None | Some(DiffState::Loading) => {
            frame.render_widget(
                Paragraph::new("Loading the diff…").style(theme::dim()),
                area,
            );
            return;
        }
        Some(DiffState::Failed(e)) => {
            frame.render_widget(Paragraph::new(e.clone()).style(theme::error()), area);
            return;
        }
        Some(DiffState::Loaded(None)) => {
            frame.render_widget(
                Paragraph::new("Not a git repository: nothing to diff.").style(theme::dim()),
                area,
            );
            return;
        }
        Some(DiffState::Loaded(Some(diff))) if diff.files.is_empty() => {
            frame.render_widget(Paragraph::new("No changes.").style(theme::dim()), area);
            return;
        }
        Some(DiffState::Loaded(Some(diff))) => diff,
    };
    let files = diff::file_lines(diff);
    let list_height = (files.len() as u16).min(area.height / 3).max(1);
    let [list_area, patch_area] =
        Layout::vertical([Constraint::Length(list_height), Constraint::Min(0)]).areas(area);
    let list = List::new(files).highlight_style(theme::selected());
    let mut state = ListState::default().with_selected(Some(d.diff_cursor));
    frame.render_stateful_widget(list, list_area, &mut state);
    if let Some(file) = diff.files.get(d.diff_cursor) {
        let block = Block::default()
            .borders(ratatui::widgets::Borders::TOP)
            .border_style(theme::dim());
        frame.render_widget(
            Paragraph::new(diff::patch_lines(file))
                .block(block)
                .scroll((d.diff_scroll, 0))
                .style(Style::new()),
            patch_area,
        );
    }
}
