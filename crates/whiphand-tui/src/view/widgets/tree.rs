//! The step tree: one line per node, stage and attempt, folded the way the
//! desktop's stepper folds it (`whiphand_core::run_tree`).

use ratatui::style::Style;
use ratatui::text::{Line, Span};
use whiphand_core::js::number_to_string;
use whiphand_core::run_tree::{StageGroup, StepNode, stage_rollup};

use crate::model::detail::{RunDetail, TreeLine};
use crate::view::theme;

fn n(v: f64) -> String {
    number_to_string(v)
}

fn fold_mark(line: &TreeLine, collapsed: bool) -> &'static str {
    if !line.is_container() {
        "  "
    } else if collapsed {
        "▸ "
    } else {
        "▾ "
    }
}

fn node_spans(node: &StepNode, filtered: bool) -> Vec<Span<'static>> {
    let row = node.row();
    let mut spans = vec![
        Span::styled(
            format!("{} ", theme::glyph(&row.status)),
            theme::status(&row.status),
        ),
        Span::styled(
            node.id().to_string(),
            if filtered {
                theme::bold()
            } else {
                Style::new()
            },
        ),
    ];
    match node {
        StepNode::Step(leaf) => {
            if leaf.executions.len() > 1 {
                spans.push(Span::styled(
                    format!(" ×{}", leaf.executions.len()),
                    theme::dim(),
                ));
            }
            match row.verdict.as_deref() {
                Some("pass") => spans.push(Span::styled(" pass", theme::status("done"))),
                Some("fail") => spans.push(Span::styled(" fail", theme::status("failed"))),
                _ => {}
            }
        }
        StepNode::Loop(l) => {
            let ran = l.row.iterations.map(n).unwrap_or_else(|| "0".into());
            let of = l
                .row
                .max_iterations
                .map(|m| format!("/{}", n(m)))
                .unwrap_or_default();
            spans.push(Span::styled(format!("  ↻ {ran}{of}"), theme::dim()));
        }
        StepNode::Stages(s) => {
            let total = s.row.total.map(n).unwrap_or_else(|| "?".into());
            let text = match (s.row.completed, &s.row.current_stage) {
                (Some(done), _) => format!("  {} of {total} stages done", n(done)),
                (None, Some(current)) => format!("  on stage {} of {total}", n(current.index)),
                (None, None) => format!("  {total} stages"),
            };
            spans.push(Span::styled(text, theme::dim()));
        }
    }
    if filtered {
        spans.push(Span::styled("  ◂ log", theme::dim()));
    }
    spans
}

fn group_spans(attempts: &[&StageGroup], group: &StageGroup, now_ms: f64) -> Vec<Span<'static>> {
    let Some(label) = group.label() else {
        return vec![Span::styled("not started yet", theme::dim())];
    };
    let mut spans = vec![Span::raw(label)];
    if group.attempts > 1 {
        let of = group
            .max_attempts
            .map(|m| format!(" of {}", n(m)))
            .unwrap_or_default();
        let attempt = group.attempt.map(n).unwrap_or_default();
        spans.push(Span::styled(
            format!("  attempt {attempt}{of}"),
            theme::dim(),
        ));
    }
    // The stage's header speaks for every attempt at it.
    let rollup = stage_rollup(attempts, now_ms);
    let mut facts = vec![rollup.status.clone()];
    facts.extend(rollup.elapsed);
    facts.extend(rollup.spend);
    spans.push(Span::styled(
        format!("  {}", facts.join(" · ")),
        theme::status(&rollup.status),
    ));
    spans
}

/// The tree's lines, the cursor's one marked when `focused`.
pub fn lines(d: &RunDetail, now_ms: f64) -> Vec<Line<'static>> {
    d.tree_lines()
        .iter()
        .map(|line| {
            let (depth, collapsed) = match line {
                TreeLine::Node {
                    depth, collapsed, ..
                }
                | TreeLine::Group {
                    depth, collapsed, ..
                } => (*depth, *collapsed),
            };
            let mut spans = vec![Span::raw(format!(
                "{}{}",
                "  ".repeat(depth),
                fold_mark(line, collapsed)
            ))];
            match line {
                TreeLine::Node { node, .. } => {
                    let filtered = d.filter_step.as_deref() == Some(node.id());
                    spans.extend(node_spans(node, filtered));
                }
                TreeLine::Group { stages, group, .. } => {
                    let attempts: Vec<&StageGroup> = stages
                        .children
                        .iter()
                        .filter(|g| g.stage.is_some() && g.stage == group.stage)
                        .collect();
                    spans.extend(group_spans(&attempts, group, now_ms));
                }
            }
            Line::from(spans)
        })
        .collect()
}
