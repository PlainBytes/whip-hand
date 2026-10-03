//! `log-rows.ts`: the row format of `run.log`: what one event summarizes
//! to, and how a row is written as a line. Also the shared spellings of a
//! step's progress (`nested_prefix`, `progress_action_text`, `merge_usage`,
//! `usage_parts`) that the CLI renderer and the journal both use.
//!
//! Events arrive as the JS objects the engine emitted (see `jsval`), so the
//! summary reads them field by field the way the TS `switch` does.

use crate::degradations::degradation_line;
use crate::format::{format_bytes, stage_label};
use crate::jsval::{JsObject, JsValue, ObjExt};

/// One line's budget, after which it is truncated with a marker.
pub const MAX_LOG_LINE_BYTES: usize = 8 * 1024;

const TRUNCATED_MARKER: &str = "…[truncated]";

/// Injected by command steps, never a workflow-declared secret, so never redacted.
const WHIPHAND_ENV_KEYS: &[&str] = &[
    "WHIPHAND_RUN_DIR",
    "WHIPHAND_RUN_ID",
    "WHIPHAND_RUN_SLUG",
    "WHIPHAND_RUN_NAME",
    "WHIPHAND_STEP_ID",
];

/// A summarized event, before it gets its `seq` and `ts`.
#[derive(Clone, Debug, PartialEq)]
pub struct LogRow {
    pub kind: String,
    pub step_id: Option<String>,
    pub text: String,
    pub stream: Option<String>,
}

/// JS truthiness.
fn truthy(v: &JsValue) -> bool {
    match v {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(b) => *b,
        JsValue::Num(n) => *n != 0.0 && !n.is_nan(),
        JsValue::Str(s) => !s.is_empty(),
        JsValue::Arr(_) | JsValue::Obj(_) => true,
    }
}

/// `${v}`.
fn s(v: &JsValue) -> String {
    v.to_js_string()
}

/// `v ?? fallback`, interpolated.
fn or(v: &JsValue, fallback: &str) -> String {
    if v.is_nullish() {
        fallback.to_string()
    } else {
        s(v)
    }
}

/// `<id>` prefixed with every loop (or stage) enclosing it, outermost first,
/// e.g. `human-review 2 › fix-cycle`. Empty of ancestors for a top-level loop.
pub fn nested_prefix(
    id: &str,
    parent_loop_id: &JsValue,
    parent_iteration: &JsValue,
    outer_loops: &JsValue,
    parent_stage: &JsValue,
) -> String {
    let mut ancestors: Vec<(String, String, Option<String>)> = outer_loops
        .as_arr()
        .unwrap_or(&[])
        .iter()
        .map(|l| {
            let stage = l.get("stage");
            (
                s(l.get("id")),
                s(l.get("iteration")),
                (!stage.is_undefined()).then(|| s(stage)),
            )
        })
        .collect();
    if !parent_loop_id.is_undefined() {
        ancestors.push((
            s(parent_loop_id),
            or(parent_iteration, "1"),
            (!parent_stage.is_undefined()).then(|| s(parent_stage)),
        ));
    }
    if ancestors.is_empty() {
        return id.to_string();
    }
    let labels: Vec<String> = ancestors
        .iter()
        .map(|(id, it, stage)| match stage {
            None => format!("{id} {it}"),
            Some(st) => format!("{id}/{st} {it}"),
        })
        .collect();
    format!("{} › {id}", labels.join(" › "))
}

fn loop_event_label(e: &JsObject) -> String {
    nested_prefix(
        &s(e.prop("loopId")),
        e.prop("parentLoopId"),
        e.prop("parentIteration"),
        e.prop("outerLoops"),
        e.prop("parentStage"),
    )
}

/// A tool call as one line of activity: `Read foo.ts`, or just `Bash`.
pub fn progress_action_text(progress: &JsObject) -> String {
    let target = progress.prop("target");
    if target.is_undefined() {
        s(progress.prop("tool"))
    } else {
        format!("{} {}", s(progress.prop("tool")), s(target))
    }
}

const USAGE_KEYS: [&str; 3] = ["turns", "costUsd", "premiumRequests"];

/// `{ ...base }` with every counter `usage` reported laid over it: a report
/// is a running total, so a present field replaces and an absent one leaves
/// the earlier value alone.
pub fn merge_usage(base: &JsObject, usage: &JsObject) -> JsObject {
    let mut next = base.clone();
    for key in USAGE_KEYS {
        let v = usage.prop(key);
        if !v.is_undefined() {
            next.set(key, v.clone());
        }
    }
    next
}

/// The present counters as labelled parts, turns first.
pub fn usage_parts(usage: &JsObject, format_cost: impl Fn(&JsValue) -> String) -> Vec<String> {
    let mut parts = Vec::new();
    let turns = usage.prop("turns");
    if !turns.is_undefined() {
        parts.push(format!("{} turns", s(turns)));
    }
    let cost = usage.prop("costUsd");
    if !cost.is_undefined() {
        parts.push(format_cost(cost));
    }
    let premium = usage.prop("premiumRequests");
    if !premium.is_undefined() {
        parts.push(format!("{} premium requests", s(premium)));
    }
    parts
}

fn redacted_env_suffix(env: &JsValue) -> String {
    let keys: Vec<&str> = env
        .as_obj()
        .map(|o| {
            o.keys()
                .filter(|k| !WHIPHAND_ENV_KEYS.contains(k))
                .collect()
        })
        .unwrap_or_default();
    if keys.is_empty() {
        return String::new();
    }
    let listed: Vec<String> = keys.iter().map(|k| format!("{k}=<redacted>")).collect();
    format!(", env: {{{}}}", listed.join(", "))
}

fn row(kind: &str, step_id: Option<&JsValue>, text: String) -> LogRow {
    LogRow {
        kind: kind.to_string(),
        step_id: step_id.filter(|v| !v.is_nullish()).map(s),
        text,
        stream: None,
    }
}

/// The human summary of one event, what `format_log_line` serializes.
/// `None` for an event type the TS union does not have.
pub fn summarize_event(event: &JsObject) -> Option<LogRow> {
    let ty = event.str_prop("type")?;
    let p = |k: &str| event.prop(k);
    let step = Some(p("stepId"));
    let r = match ty {
        "run:start" => {
            let mut parts = vec![format!("run started: workflow '{}'", s(p("workflow")))];
            if !p("name").is_undefined() {
                parts.push(format!("name '{}'", s(p("name"))));
            }
            if !p("source").is_undefined() {
                parts.push(format!("source {}", s(p("source"))));
            }
            if let Some(a) = p("attachments").as_arr().filter(|a| !a.is_empty()) {
                parts.push(format!("{} attachment(s)", a.len()));
            }
            row(ty, None, parts.join(", "))
        }
        "run:resume" => {
            let mut parts = vec![format!("run resumed: workflow '{}'", s(p("workflow")))];
            if !p("from").is_undefined() {
                let it = if p("iteration").is_undefined() {
                    String::new()
                } else {
                    format!(" iteration {}", s(p("iteration")))
                };
                parts.push(format!("from step '{}'{it}", s(p("from"))));
            }
            if !p("name").is_undefined() {
                parts.push(format!("name '{}'", s(p("name"))));
            }
            row(ty, None, parts.join(", "))
        }
        "step:start" => {
            let runner = if p("runner").is_undefined() {
                String::new()
            } else {
                format!(", runner={}", s(p("runner")))
            };
            let mode = if p("mode").is_undefined() {
                String::new()
            } else {
                format!(", mode={}", s(p("mode")))
            };
            row(
                ty,
                step,
                format!("step started ({}{runner}{mode})", s(p("kind"))),
            )
        }
        "step:skipped" => row(
            ty,
            step,
            "step skipped (reused from an earlier attempt)".into(),
        ),
        "step:spawn" => {
            let spec = p("spec");
            let argv = spec.get("argv").as_arr().unwrap_or(&[]);
            let prompt = argv.last().map_or(String::new(), |v| or(v, ""));
            let first = argv.first().map_or("?".to_string(), |v| or(v, "?"));
            let mode = if truthy(spec.get("interactive")) {
                "interactive"
            } else {
                "headless"
            };
            let text = format!(
                "spawn {first} ({mode}), {} arg(s), prompt {}{} [{}]",
                argv.len(),
                format_bytes(prompt.len() as f64),
                redacted_env_suffix(spec.get("env")),
                s(p("phase"))
            );
            row(ty, step, text)
        }
        "step:session" => row(
            ty,
            step,
            format!("session id captured: {}", s(p("sessionId"))),
        ),
        "step:artifact" => {
            let bytes = if p("bytes").is_undefined() {
                String::new()
            } else {
                format!(
                    " ({})",
                    format_bytes(p("bytes").as_f64().unwrap_or(f64::NAN))
                )
            };
            row(ty, step, format!("wrote artifact {}{bytes}", s(p("path"))))
        }
        "step:artifact-missing" => row(
            ty,
            step,
            format!("artifact {}: {}", s(p("reason")), s(p("path"))),
        ),
        "step:timeout" => row(ty, step, format!("timed out after {}ms", s(p("timeoutMs")))),
        "step:retry" => row(ty, step, format!("retrying (attempt {})", s(p("attempt")))),
        "step:log" => LogRow {
            kind: format!("{ty}:{}", s(p("stream"))),
            step_id: step.filter(|v| !v.is_nullish()).map(s),
            text: s(p("line")),
            stream: Some(s(p("stream"))),
        },
        "session:await" => {
            let text = if truthy(p("awaiting")) {
                format!("awaiting human ({})", or(p("reason"), "unknown"))
            } else {
                "no longer awaiting".into()
            };
            row(ty, step, text)
        }
        "session:ended" => row(ty, step, format!("session ended via {}", s(p("via")))),
        "step:pty-exit" => {
            let reason = if p("reason").is_undefined() {
                String::new()
            } else {
                format!(" ({})", s(p("reason")))
            };
            row(
                ty,
                step,
                format!("pty exited, code {}{reason}", s(p("exitCode"))),
            )
        }
        "run:env" => {
            let runners: Vec<String> = p("runners")
                .as_arr()
                .unwrap_or(&[])
                .iter()
                .map(|r| {
                    let suffix = if !r.get("version").is_undefined() {
                        format!("@{}", s(r.get("version")))
                    } else if truthy(r.get("installed")) {
                        String::new()
                    } else {
                        " (not installed)".into()
                    };
                    format!("{}{suffix}", s(r.get("id")))
                })
                .collect();
            let runners = runners.join(", ");
            let git = p("git");
            let git = if git.is_undefined() {
                String::new()
            } else {
                let sha16: Vec<u16> = s(git.get("sha")).encode_utf16().take(7).collect();
                let sha = String::from_utf16_lossy(&sha16);
                let state = if truthy(git.get("dirty")) {
                    "dirty"
                } else {
                    "clean"
                };
                format!(", git {sha} ({state})")
            };
            let shell = if p("shell").is_undefined() {
                String::new()
            } else {
                format!(", shell {}", s(p("shell")))
            };
            let runners = if runners.is_empty() {
                "none".to_string()
            } else {
                runners
            };
            row(
                ty,
                None,
                format!(
                    "whiphand {}, node {}, {}, runners: {runners}{git}{shell}",
                    s(p("whiphandVersion")),
                    s(p("nodeVersion")),
                    s(p("platform"))
                ),
            )
        }
        "step:tree-delta" => {
            let files = p("files");
            let count = files.as_arr().map_or(0, <[JsValue]>::len);
            let joined: Vec<String> = files.as_arr().unwrap_or(&[]).iter().map(s).collect();
            row(
                ty,
                step,
                format!("touched {count} file(s): {}", joined.join(", ")),
            )
        }
        "step:verdict" => row(ty, step, format!("verdict: {}", s(p("verdict")))),
        "step:done" => row(ty, step, format!("done, exit code {}", s(p("exitCode")))),
        "step:manual" => row(
            ty,
            step,
            format!("waiting on a human: {}", s(p("request").get("title"))),
        ),
        "step:manual-resolved" => row(ty, step, format!("human answered: {}", s(p("choice")))),
        "loop:start" => row(
            ty,
            None,
            format!(
                "loop '{}' started, up to {} iteration(s)",
                loop_event_label(event),
                s(p("maxIterations"))
            ),
        ),
        "loop:iteration" => row(
            ty,
            None,
            format!(
                "loop '{}' iteration {}/{}",
                loop_event_label(event),
                s(p("iteration")),
                s(p("maxIterations"))
            ),
        ),
        "loop:done" => {
            let outcome = if truthy(p("passed")) {
                "passed"
            } else {
                "did not pass"
            };
            row(
                ty,
                None,
                format!(
                    "loop '{}' {outcome} after {} iteration(s)",
                    loop_event_label(event),
                    s(p("iterations"))
                ),
            )
        }
        "stages:start" => row(
            ty,
            Some(p("id")),
            format!("stages started, {} stage(s)", s(p("total"))),
        ),
        "stages:item" => row(
            ty,
            Some(p("id")),
            format!(
                "{} (attempt {})",
                stage_label(&s(p("index")), &s(p("total")), &s(p("title"))),
                s(p("attempt"))
            ),
        ),
        "stages:accepted" => row(
            ty,
            Some(p("id")),
            format!("stage accepted: {}", s(p("stageId"))),
        ),
        "stages:exhausted" => row(
            ty,
            Some(p("id")),
            format!(
                "stage {} rejected {} time(s), handed to triage",
                s(p("stageId")),
                s(p("attempts"))
            ),
        ),
        "stages:done" => row(
            ty,
            Some(p("id")),
            format!("stages done, {} completed", s(p("completed"))),
        ),
        "guard:warning" => row(ty, step, s(p("message"))),
        "run:degraded" => {
            let step_id = p("stepId");
            let step_text = (!step_id.is_undefined()).then(|| s(step_id));
            row(
                ty,
                step,
                format!(
                    "degraded: {}",
                    degradation_line(&s(p("capability")), &s(p("reason")), step_text.as_deref())
                ),
            )
        }
        "run:done" => row(
            ty,
            None,
            format!(
                "run done: {}",
                if truthy(p("ok")) { "ok" } else { "failed" }
            ),
        ),
        "run:error" => row(ty, step, s(p("message"))),
        "run:cancelled" => row(ty, None, "run cancelled".into()),
        "step:progress" => {
            let progress = p("progress").as_obj().cloned().unwrap_or_default();
            match progress.str_prop("kind") {
                Some("tool") => row("step:progress:tool", step, progress_action_text(&progress)),
                Some("text") => row("step:progress:text", step, s(progress.prop("text"))),
                _ => row(
                    "step:progress:usage",
                    step,
                    usage_parts(&progress, |usd| format!("${}", s(usd))).join(", "),
                ),
            }
        }
        _ => return None,
    };
    Some(r)
}

/// `text`'s structural hazards, a newline and the escape character itself,
/// each expanded to a fixed two-character token in one pass.
fn escape_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out
}

/// `<ISO ts>  <seq>  <kind>  <stepId|->  <text>\n`, two-space separated,
/// with an over-long line cut at a byte budget and marked.
pub fn format_log_line(seq: u64, ts: &str, row: &LogRow) -> String {
    let prefix = format!(
        "{ts}  {seq}  {}  {}  ",
        row.kind,
        row.step_id.as_deref().unwrap_or("-")
    );
    let mut text = escape_text(&row.text);
    let budget = MAX_LOG_LINE_BYTES as i64 - prefix.len() as i64;
    if budget > 0 && text.len() as i64 > budget {
        let keep = (budget - TRUNCATED_MARKER.len() as i64).max(0) as usize;
        // TextDecoder over a cut mid-character: the partial sequence becomes U+FFFD.
        let kept = String::from_utf8_lossy(&text.as_bytes()[..keep]).into_owned();
        text = format!("{kept}{TRUNCATED_MARKER}");
    }
    format!("{prefix}{text}\n")
}

/// A line for a row that has no event behind it (the `log:truncated` note).
pub fn format_note_line(seq: u64, ts: &str, kind: &str, text: &str) -> String {
    format_log_line(
        seq,
        ts,
        &LogRow {
            kind: kind.into(),
            step_id: None,
            text: text.into(),
            stream: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obj;

    #[test]
    fn spawn_summary_redacts_env() {
        let ev = obj! {
            "type" => "step:spawn", "stepId" => "a", "phase" => "main",
            "spec" => obj! {
                "argv" => vec![JsValue::from("claude"), JsValue::from("x".repeat(2000))],
                "interactive" => false,
                "env" => obj! { "WHIPHAND_RUN_ID" => "r", "TOKEN" => "s" },
            },
        };
        let r = summarize_event(&ev).unwrap();
        assert_eq!(
            r.text,
            "spawn claude (headless), 2 arg(s), prompt 2 KB, env: {TOKEN=<redacted>} [main]"
        );
    }

    #[test]
    fn nested_loop_label() {
        let ev = obj! {
            "type" => "loop:iteration", "loopId" => "fix", "iteration" => 2u32, "maxIterations" => 3u32,
            "parentLoopId" => "review", "parentIteration" => 2u32,
        };
        assert_eq!(
            summarize_event(&ev).unwrap().text,
            "loop 'review 2 › fix' iteration 2/3"
        );
    }

    #[test]
    fn long_line_is_cut_on_bytes() {
        let r = LogRow {
            kind: "step:log:stdout".into(),
            step_id: Some("a".into()),
            text: "é".repeat(9000),
            stream: None,
        };
        let line = format_log_line(1, "2024-01-01T00:00:00.000Z", &r);
        // A cut through a character decodes to U+FFFD, which can run a byte
        // or two past the budget, exactly as TextDecoder does in TS.
        assert!(line.len() <= MAX_LOG_LINE_BYTES + 3);
        assert!(line.ends_with("…[truncated]\n"));
    }

    #[test]
    fn escapes() {
        assert_eq!(escape_text("a\\n\nb"), "a\\\\n\\nb");
    }
}
