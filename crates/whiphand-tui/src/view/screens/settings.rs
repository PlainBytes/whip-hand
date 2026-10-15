//! The settings screen: one pane at a time, named in a bar at the top.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Cell, Paragraph, Row, Table, TableState, Wrap};
use whiphand_protocol::{ModelListRow, ModelSource};

use crate::model::Model;
use crate::model::settings::{Key, Pane};
use crate::view::theme;

pub fn render(model: &Model, frame: &mut Frame, area: Rect) {
    let s = &model.settings;
    let block = Block::bordered().title(" Settings ");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let [bar, body] = Layout::vertical([Constraint::Length(2), Constraint::Fill(1)]).areas(inner);
    let mut spans = Vec::new();
    for pane in Pane::ALL {
        let style = if pane == s.pane {
            theme::selected()
        } else {
            theme::dim()
        };
        spans.push(Span::styled(format!(" {} ", pane.title()), style));
        spans.push(Span::raw(" "));
    }
    spans.push(Span::styled(" Tab switches", theme::dim()));
    frame.render_widget(Paragraph::new(Line::from(spans)), bar);
    match s.pane {
        Pane::Workspace | Pane::Global => render_config(model, s.pane, frame, body),
        Pane::Tui => render_tui(model, frame, body),
        Pane::Models => render_models(model, frame, body),
    }
}

fn rows_table<'a>(rows: Vec<Row<'a>>, selected: usize) -> (Table<'a>, TableState) {
    let table = Table::new(
        rows,
        [
            Constraint::Length(30),
            Constraint::Fill(1),
            Constraint::Length(14),
        ],
    )
    .row_highlight_style(theme::selected());
    (table, TableState::default().with_selected(Some(selected)))
}

fn render_config(model: &Model, pane: Pane, frame: &mut Frame, area: Rect) {
    let s = &model.settings;
    if pane == Pane::Workspace && model.workdir.is_none() {
        let p = Paragraph::new("No workspace is open.").style(theme::dim());
        frame.render_widget(p, area);
        return;
    }
    let Some(config) = s.config(pane) else {
        frame.render_widget(Paragraph::new("Loading…").style(theme::dim()), area);
        return;
    };
    let rows: Vec<Row> = Key::ALL
        .iter()
        .map(|key| {
            let source = match pane {
                Pane::Workspace if s.overrides(*key) => Span::raw("this workspace"),
                Pane::Workspace => Span::styled("inherited", theme::dim()),
                _ if s.global_sets(*key) => Span::raw("set"),
                _ => Span::styled("default", theme::dim()),
            };
            Row::new(vec![
                Cell::from(key.label()),
                Cell::from(key.show(config)),
                Cell::from(source),
            ])
        })
        .collect();
    let [table_area, notes] = Layout::vertical([
        Constraint::Length(Key::ALL.len() as u16 + 1),
        Constraint::Fill(1),
    ])
    .areas(area);
    let (table, mut state) = rows_table(rows, s.selected);
    frame.render_stateful_widget(table, table_area, &mut state);
    let path = match pane {
        Pane::Workspace => s.project.as_ref().and_then(|r| r.project.as_ref()),
        _ => s.global.as_ref().map(|r| &r.global),
    }
    .map(|l| {
        let note = if l.exists { "" } else { " (not written yet)" };
        format!("{}{note}", l.path)
    });
    let mut lines = vec![Line::styled(
        match pane {
            Pane::Workspace => {
                "Enter changes the row  ·  u uses the global value  ·  P deletes runs beyond the maximum now"
            }
            _ => "Enter changes the row; every workspace that does not set its own uses it",
        },
        theme::dim(),
    )];
    if let Some(path) = path {
        lines.push(Line::styled(format!("Saved in {path}"), theme::dim()));
    }
    frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), notes);
}

fn render_tui(model: &Model, frame: &mut Frame, area: Rect) {
    let prefs = &model.prefs;
    let yes_no = |b: bool| if b { "yes" } else { "no" };
    let rows = vec![
        Row::new(vec![
            Cell::from("Attach automatically"),
            Cell::from(yes_no(prefs.attach_auto == Some(true))),
            Cell::from(""),
        ]),
        Row::new(vec![
            Cell::from("Detach key"),
            Cell::from(model.detach_key().label()),
            Cell::from(""),
        ]),
        Row::new(vec![
            Cell::from("Log file"),
            Cell::from(model.log_path.clone().unwrap_or_default()),
            Cell::from(""),
        ]),
    ];
    let [table_area, notes] =
        Layout::vertical([Constraint::Length(4), Constraint::Fill(1)]).areas(area);
    let (table, mut state) = rows_table(rows, model.settings.selected);
    frame.render_stateful_widget(table, table_area, &mut state);
    let text = format!(
        "Attach automatically: a run started here hands its interactive step the terminal when it starts. \
         {key} detaches; {key} twice sends it to the session; {key} e ends the session.",
        key = model.detach_key().label()
    );
    let p = Paragraph::new(text)
        .style(theme::dim())
        .wrap(Wrap { trim: true });
    frame.render_widget(p, notes);
}

fn render_models(model: &Model, frame: &mut Frame, area: Rect) {
    let Some(models) = &model.settings.models else {
        frame.render_widget(
            Paragraph::new("Asking the runners…").style(theme::dim()),
            area,
        );
        return;
    };
    let mut lines = Vec::new();
    for (runner, row) in &models.0 {
        let Ok(row) = serde_json::from_value::<ModelListRow>(row.clone()) else {
            continue;
        };
        let (source, style) = match row.source {
            ModelSource::Live => ("live", theme::status("done")),
            ModelSource::Fallback => ("built-in list", theme::waiting()),
            ModelSource::Unavailable => ("unavailable", theme::error()),
        };
        lines.push(Line::from(vec![
            Span::styled(runner.clone(), theme::bold()),
            Span::styled(format!("  {source}"), style),
        ]));
        if let Some(note) = &row.note {
            lines.push(Line::styled(format!("  {note}"), theme::dim()));
        }
        for m in &row.models {
            let mut spans = vec![Span::raw(format!("  {}", m.id))];
            if let Some(label) = m.label.as_ref().filter(|l| **l != m.id) {
                spans.push(Span::styled(format!("  {label}"), theme::dim()));
            }
            if let Some(to) = &m.resolves {
                spans.push(Span::styled(format!("  → {to}"), theme::dim()));
            }
            lines.push(Line::from(spans));
        }
        lines.push(Line::default());
    }
    if lines.is_empty() {
        lines.push(Line::styled("No runner reported any models.", theme::dim()));
    }
    lines.push(Line::styled("Ctrl-r asks the runners again", theme::dim()));
    frame.render_widget(
        Paragraph::new(lines).scroll((model.settings.scroll, 0)),
        area,
    );
}
