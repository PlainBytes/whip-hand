//! Renders the engine's event stream to the terminal (`render.ts`).
//!
//! Stateful: a headless step's progress arrives as many small events and is
//! summarised when the step ends. Deliberately no cursor control: `whiphand
//! run` output is routinely piped to a file or read by CI, and an in-place
//! spinner would corrupt both.

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use whiphand_core::degradations::degradation_line;
use whiphand_core::format::{format_bytes, format_elapsed};
use whiphand_core::js::to_fixed;
use whiphand_core::jsval::{self, JsObject, JsValue, ObjExt};
use whiphand_core::log_rows::{merge_usage, nested_prefix, progress_action_text, usage_parts};
use whiphand_core::node_path;
use whiphand_core::types::ATTACHMENTS_REF;

use crate::io::{err_line, out_line};

/// Where the lines go and what time it is; injectable so output can be asserted.
pub struct Sinks {
    pub out: Box<dyn Fn(&str)>,
    pub err: Box<dyn Fn(&str)>,
    pub now: Box<dyn Fn() -> f64>,
}

impl Default for Sinks {
    fn default() -> Self {
        Sinks {
            out: Box::new(out_line),
            err: Box::new(err_line),
            now: Box::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0.0, |d| d.as_millis() as f64)
            }),
        }
    }
}

/// A run id's directory.
pub type RunDirOf = Box<dyn Fn(&str) -> String>;

#[derive(Default)]
pub struct RenderOptions {
    /// Set for a dry run: the run directory of a run id, so a dry run can
    /// say where each attachment would have gone.
    pub run_dir_of: Option<RunDirOf>,
    /// Set for a dry run: print each prompt file's content under the spawn line.
    pub show_prompts: bool,
}

#[derive(Default)]
struct State {
    /// Headless steps only: the usage counters so far plus `startedMs`.
    tallies: HashMap<String, JsObject>,
    stage_positions: HashMap<String, (String, String)>,
    degraded: Vec<JsObject>,
    run_ended: bool,
}

pub struct Renderer {
    sinks: Sinks,
    opts: RenderOptions,
    state: RefCell<State>,
}

fn s(v: &JsValue) -> String {
    v.to_js_string()
}

/// JS truthiness for the values events carry.
fn truthy(v: &JsValue) -> bool {
    match v {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(b) => *b,
        JsValue::Num(n) => *n != 0.0 && !n.is_nan(),
        JsValue::Str(s) => !s.is_empty(),
        _ => true,
    }
}

fn named(name: &JsValue) -> String {
    if name.is_undefined() {
        String::new()
    } else {
        format!(" \"{}\"", s(name))
    }
}

fn step_line(e: &JsObject) -> String {
    let indent = if e.prop("loopId").is_undefined() {
        ""
    } else {
        "  "
    };
    let detail = if e.str_prop("kind") == Some("agent") {
        let model = e.prop("model");
        let model = if truthy(model) {
            format!(" · {}", s(model))
        } else {
            String::new()
        };
        format!("{}{model}, {}", s(e.prop("runner")), s(e.prop("mode")))
    } else {
        s(e.prop("kind"))
    };
    format!("{indent}→ step {} ({detail})", s(e.prop("stepId")))
}

fn loop_label(e: &JsObject) -> String {
    nested_prefix(
        &s(e.prop("loopId")),
        e.prop("parentLoopId"),
        e.prop("parentIteration"),
        e.prop("outerLoops"),
        e.prop("parentStage"),
    )
}

fn degradation(e: &JsObject) -> String {
    let step = e.prop("stepId");
    degradation_line(
        &s(e.prop("capability")),
        &s(e.prop("reason")),
        (!step.is_undefined()).then(|| s(step)).as_deref(),
    )
}

fn basename(path: &str) -> String {
    if cfg!(windows) {
        node_path::win32_basename(path)
    } else {
        path.rsplit('/').next().unwrap_or(path).to_string()
    }
}

/// `/\.(?:harvest-)?prompt$/`.
fn is_prompt_file(path: &str) -> bool {
    path.ends_with(".prompt") || path.ends_with(".harvest-prompt")
}

impl Renderer {
    pub fn new(sinks: Sinks, opts: RenderOptions) -> Self {
        Renderer {
            sinks,
            opts,
            state: RefCell::new(State::default()),
        }
    }

    fn out(&self, line: &str) {
        (self.sinks.out)(line);
    }

    fn err(&self, line: &str) {
        (self.sinks.err)(line);
    }

    /// Elapsed time is always known; every other counter is printed only
    /// when the runner reported it.
    fn summary(&self, tally: &JsObject) -> String {
        let mut parts = usage_parts(tally, |usd| {
            format!("${}", to_fixed(usd.as_f64().unwrap_or(f64::NAN), 2))
        });
        let started = tally.prop("startedMs").as_f64().unwrap_or(0.0);
        let at = if tally.prop("turns").is_undefined() {
            0
        } else {
            1
        };
        parts.insert(at, format_elapsed((self.sinks.now)() - started));
        format!("  {}", parts.join(" · "))
    }

    pub fn render(&self, e: &JsObject) {
        let ty = e.str_prop("type").unwrap_or_default();
        match ty {
            "run:start" => {
                let global = if e.str_prop("source") == Some("global") {
                    " (global)"
                } else {
                    ""
                };
                self.out(&format!(
                    "whiphand run {}{} — workflow '{}'{global}",
                    s(e.prop("runId")),
                    named(e.prop("name")),
                    s(e.prop("workflow"))
                ));
                let attached = e.prop("attachments").as_arr().unwrap_or(&[]);
                if attached.is_empty() {
                    return;
                }
                let listed: Vec<String> = attached
                    .iter()
                    .map(|a| {
                        format!(
                            "{} {}",
                            s(a.get("name")),
                            format_bytes(a.get("size").as_f64().unwrap_or(0.0))
                        )
                    })
                    .collect();
                self.out(&format!("📎 {}", listed.join(" · ")));
                let Some(run_dir_of) = &self.opts.run_dir_of else {
                    return;
                };
                let run_dir = run_dir_of(&s(e.prop("runId")));
                for a in attached {
                    self.out(&format!(
                        "  → {}",
                        node_path::join(&[&run_dir, ATTACHMENTS_REF, &s(a.get("name"))])
                    ));
                }
            }
            "run:resume" => {
                let from = e.prop("from");
                let iteration = e.prop("iteration");
                self.out(&format!(
                    "whiphand resume {}{} — workflow '{}'{}{}",
                    s(e.prop("runId")),
                    named(e.prop("name")),
                    s(e.prop("workflow")),
                    if from.is_undefined() {
                        String::new()
                    } else {
                        format!(", from step '{}'", s(from))
                    },
                    if iteration.is_undefined() {
                        String::new()
                    } else {
                        format!(" (iteration {})", s(iteration))
                    }
                ));
            }
            "step:skipped" => {
                let indent = if e.prop("loopId").is_undefined() {
                    ""
                } else {
                    "  "
                };
                self.out(&format!("{indent}↷ step {} (reused)", s(e.prop("stepId"))));
            }
            "step:start" => {
                if e.str_prop("mode") == Some("headless") {
                    let started = (self.sinks.now)();
                    self.state.borrow_mut().tallies.insert(
                        s(e.prop("stepId")),
                        whiphand_core::obj! { "startedMs" => started },
                    );
                }
                self.out(&step_line(e));
            }
            "step:spawn" => {
                let spec = e.prop("spec");
                let argv: Vec<String> = spec
                    .get("argv")
                    .as_arr()
                    .unwrap_or(&[])
                    .iter()
                    .map(|a| {
                        let a = s(a);
                        if a.contains(' ') {
                            jsval::stringify_compact(&JsValue::Str(a))
                        } else {
                            a
                        }
                    })
                    .collect();
                self.out(&format!("  $ {}", argv.join(" ")));
                if self.opts.show_prompts {
                    for file in spec.get("files").as_arr().unwrap_or(&[]) {
                        let path = s(file.get("path"));
                        if !is_prompt_file(&path) {
                            continue;
                        }
                        self.out(&format!("  ┆ {}:", basename(&path)));
                        for line in s(file.get("content")).split('\n') {
                            self.out(&format!("  ┆   {line}"));
                        }
                    }
                }
            }
            "step:artifact" => self.out(&format!("  ✔ artifact {}", s(e.prop("path")))),
            "step:verdict" => self.out(&format!(
                "  verdict: {}",
                s(e.prop("verdict")).to_uppercase()
            )),
            "step:progress" => {
                let Some(progress) = e.prop("progress").as_obj() else {
                    return;
                };
                match progress.str_prop("kind") {
                    Some("tool") => self.out(&format!("  {}", progress_action_text(progress))),
                    Some("usage") => {
                        let id = s(e.prop("stepId"));
                        let mut state = self.state.borrow_mut();
                        if let Some(tally) = state.tallies.get(&id) {
                            let merged = merge_usage(tally, progress);
                            state.tallies.insert(id, merged);
                        }
                    }
                    // Prose is deliberately dropped: it would drown the terminal.
                    _ => {}
                }
            }
            "step:done" => {
                let tally = self.state.borrow_mut().tallies.remove(&s(e.prop("stepId")));
                if let Some(tally) = tally {
                    self.out(&self.summary(&tally));
                }
            }
            "step:manual-resolved" => self.out(&format!("  ↳ {}", s(e.prop("choice")))),
            "loop:start" => self.out(&format!(
                "↻ loop {} (up to {} iterations)",
                loop_label(e),
                s(e.prop("maxIterations"))
            )),
            "loop:iteration" => self.out(&format!(
                "↻ {} — iteration {}/{}",
                loop_label(e),
                s(e.prop("iteration")),
                s(e.prop("maxIterations"))
            )),
            "loop:done" => {
                let verb = if e.prop("passed") == &JsValue::Bool(true) {
                    "passed"
                } else {
                    "exhausted"
                };
                self.out(&format!(
                    "↻ {} {verb} after {} iteration(s)",
                    loop_label(e),
                    s(e.prop("iterations"))
                ));
            }
            "stages:start" => self.out(&format!(
                "▤ stages {} ({} stages)",
                s(e.prop("id")),
                s(e.prop("total"))
            )),
            "stages:item" => {
                self.state
                    .borrow_mut()
                    .stage_positions
                    .insert(s(e.prop("id")), (s(e.prop("index")), s(e.prop("total"))));
                let attempt = e.prop("attempt").as_f64().unwrap_or(1.0);
                self.out(&format!(
                    "▤ {} — stage {}/{}: {}{}",
                    s(e.prop("id")),
                    s(e.prop("index")),
                    s(e.prop("total")),
                    s(e.prop("title")),
                    if attempt > 1.0 {
                        format!(" (attempt {})", s(e.prop("attempt")))
                    } else {
                        String::new()
                    }
                ));
            }
            "stages:accepted" => {
                let pos = self
                    .state
                    .borrow()
                    .stage_positions
                    .get(&s(e.prop("id")))
                    .map(|(i, t)| format!("{i}/{t}"));
                self.out(&format!(
                    "▤ {} — stage {} accepted",
                    s(e.prop("id")),
                    pos.unwrap_or_else(|| s(e.prop("stageId")))
                ));
            }
            "stages:exhausted" => self.out(&format!(
                "▤ {} — stage '{}' rejected after {} attempt(s), handed to a human",
                s(e.prop("id")),
                s(e.prop("stageId")),
                s(e.prop("attempts"))
            )),
            "stages:done" => self.out(&format!(
                "▤ {} finished {} stages",
                s(e.prop("id")),
                s(e.prop("completed"))
            )),
            "guard:warning" => self.err(&format!("  ⚠ {}", s(e.prop("message")))),
            // Invariant 7: a degraded capability is shown, held to the end so
            // it reads as a summary; one after the end is printed as it comes.
            "run:degraded" => {
                if self.state.borrow().run_ended {
                    self.err(&format!("  ⚠ degraded: {}", degradation(e)));
                } else {
                    self.state.borrow_mut().degraded.push(e.clone());
                }
            }
            "run:error" => self.err(&format!("✘ {}", s(e.prop("message")))),
            "run:cancelled" => self.out("✖ run cancelled"),
            "run:done" => {
                self.state.borrow_mut().run_ended = true;
                self.out(if e.prop("ok") == &JsValue::Bool(true) {
                    "✔ run complete"
                } else {
                    "✘ run failed"
                });
                let degraded = std::mem::take(&mut self.state.borrow_mut().degraded);
                for d in &degraded {
                    self.err(&format!("  ⚠ degraded: {}", degradation(d)));
                }
            }
            // step:manual: the prompt itself is the rendering, on stderr.
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use super::*;
    use whiphand_core::jsval::from_json;

    struct Capture {
        out: Rc<RefCell<Vec<String>>>,
        err: Rc<RefCell<Vec<String>>>,
        clock: Rc<Cell<f64>>,
        r: Renderer,
    }

    impl Capture {
        fn new(opts: RenderOptions) -> Self {
            let out = Rc::new(RefCell::new(Vec::new()));
            let err = Rc::new(RefCell::new(Vec::new()));
            let clock = Rc::new(Cell::new(0.0));
            let (o, e, c) = (out.clone(), err.clone(), clock.clone());
            let sinks = Sinks {
                out: Box::new(move |l| o.borrow_mut().push(l.to_string())),
                err: Box::new(move |l| e.borrow_mut().push(l.to_string())),
                now: Box::new(move || c.get()),
            };
            Capture {
                out,
                err,
                clock,
                r: Renderer::new(sinks, opts),
            }
        }

        fn render(&self, event: serde_json::Value) {
            let JsValue::Obj(o) = from_json(&event) else {
                panic!("an event is an object")
            };
            self.r.render(&o);
        }

        fn out(&self) -> Vec<String> {
            self.out.borrow().clone()
        }

        fn last(&self) -> String {
            self.out.borrow().last().cloned().unwrap_or_default()
        }

        fn err(&self) -> Vec<String> {
            self.err.borrow().clone()
        }
    }

    fn capture() -> Capture {
        Capture::new(RenderOptions::default())
    }

    fn start_headless() -> serde_json::Value {
        serde_json::json!({
            "type": "step:start", "stepId": "impl", "kind": "agent", "runner": "claude", "model": "opus", "mode": "headless",
        })
    }

    fn with(mut v: serde_json::Value, key: &str, value: &str) -> serde_json::Value {
        v[key] = value.into();
        v
    }

    use serde_json::json;

    #[test]
    fn tool_calls_print_one_line_and_prose_prints_nothing() {
        let c = capture();
        c.render(json!({ "type": "step:progress", "stepId": "impl", "progress": { "kind": "tool", "tool": "Read", "target": "runner.ts" } }));
        c.render(json!({ "type": "step:progress", "stepId": "impl", "progress": { "kind": "tool", "tool": "TodoWrite" } }));
        c.render(json!({ "type": "step:progress", "stepId": "impl", "progress": { "kind": "text", "text": "Let me look…" } }));
        assert_eq!(c.out(), ["  Read runner.ts", "  TodoWrite"]);
    }

    #[test]
    fn a_finished_step_summarises_turns_elapsed_and_cost() {
        let c = capture();
        c.render(start_headless());
        c.render(json!({ "type": "step:progress", "stepId": "impl", "progress": { "kind": "usage", "turns": 7, "costUsd": 0.41 } }));
        c.clock.set(192_000.0);
        c.render(json!({ "type": "step:done", "stepId": "impl", "exitCode": 0 }));
        assert_eq!(c.last(), "  7 turns · 3m 12s · $0.41");
    }

    #[test]
    fn a_copilot_step_summarises_premium_requests() {
        let c = capture();
        c.render(with(start_headless(), "runner", "copilot"));
        c.render(json!({ "type": "step:progress", "stepId": "impl", "progress": { "kind": "usage", "turns": 2 } }));
        c.render(json!({ "type": "step:progress", "stepId": "impl", "progress": { "kind": "usage", "premiumRequests": 0.33 } }));
        c.clock.set(45_000.0);
        c.render(json!({ "type": "step:done", "stepId": "impl", "exitCode": 0 }));
        assert_eq!(c.last(), "  2 turns · 45s · 0.33 premium requests");
    }

    #[test]
    fn no_counters_degrades_to_elapsed_and_each_step_has_its_own_clock() {
        let c = capture();
        c.render(start_headless());
        c.clock.set(5_000.0);
        c.render(json!({ "type": "step:done", "stepId": "impl", "exitCode": 0 }));
        assert_eq!(c.last(), "  5s");
        c.clock.set(30_000.0);
        c.render(with(start_headless(), "stepId", "review"));
        c.clock.set(61_000.0);
        c.render(json!({ "type": "step:done", "stepId": "review", "exitCode": 0 }));
        assert_eq!(c.last(), "  31s");
    }

    #[test]
    fn a_cost_rounds_half_up_as_to_fixed_does() {
        let c = capture();
        c.render(start_headless());
        c.render(json!({ "type": "step:progress", "stepId": "impl", "progress": { "kind": "usage", "costUsd": 0.125 } }));
        c.render(json!({ "type": "step:done", "stepId": "impl", "exitCode": 0 }));
        assert_eq!(c.last(), "  0s · $0.13");
    }

    #[test]
    fn step_lines() {
        let c = capture();
        c.render(with(
            with(start_headless(), "runner", "opencode"),
            "model",
            "opencode/claude-haiku-4-5",
        ));
        c.render(with(start_headless(), "model", ""));
        c.render(json!({ "type": "step:start", "stepId": "tests", "kind": "command" }));
        c.clock.set(9_000.0);
        // A command step streams its own output: no summary line.
        c.render(json!({ "type": "step:done", "stepId": "tests", "exitCode": 0 }));
        assert_eq!(
            c.out(),
            [
                "→ step impl (opencode · opencode/claude-haiku-4-5, headless)",
                "→ step impl (claude, headless)",
                "→ step tests (command)",
            ]
        );
    }

    #[test]
    fn the_per_event_rendering() {
        let c = capture();
        c.render(json!({ "type": "run:start", "runId": "r1", "workflow": "cycle" }));
        c.render(start_headless());
        c.render(json!({ "type": "step:artifact", "stepId": "impl", "path": ".whiphand/runs/r1/impl.md" }));
        c.render(json!({ "type": "step:verdict", "stepId": "impl", "verdict": "pass" }));
        c.render(json!({ "type": "loop:iteration", "loopId": "fix", "iteration": 2, "maxIterations": 5 }));
        c.render(json!({ "type": "guard:warning", "message": "uncommitted changes" }));
        c.render(json!({ "type": "step:manual-resolved", "stepId": "gate", "choice": "retry" }));
        c.render(json!({ "type": "run:cancelled", "runId": "r1" }));
        c.render(json!({ "type": "run:error", "message": "boom" }));
        c.render(json!({ "type": "run:done", "runId": "r1", "ok": false }));
        assert_eq!(
            c.out(),
            [
                "whiphand run r1 — workflow 'cycle'",
                "→ step impl (claude · opus, headless)",
                "  ✔ artifact .whiphand/runs/r1/impl.md",
                "  verdict: PASS",
                "↻ fix — iteration 2/5",
                "  ↳ retry",
                "✖ run cancelled",
                "✘ run failed",
            ]
        );
        assert_eq!(c.err(), ["  ⚠ uncommitted changes", "✘ boom"]);
    }

    #[test]
    fn run_start_and_resume() {
        let c = capture();
        c.render(
            json!({ "type": "run:start", "runId": "r1", "workflow": "cycle", "source": "project" }),
        );
        c.render(json!({ "type": "run:start", "runId": "r2", "workflow": "cycle", "source": "global", "name": "Ship it" }));
        c.render(json!({ "type": "run:resume", "runId": "r1", "workflow": "cycle", "from": "execute", "iteration": 2 }));
        c.render(json!({ "type": "run:resume", "runId": "r1", "workflow": "cycle" }));
        c.render(json!({ "type": "step:skipped", "stepId": "plan" }));
        c.render(
            json!({ "type": "step:skipped", "stepId": "edit", "loopId": "fix", "iteration": 2 }),
        );
        assert_eq!(
            c.out(),
            [
                "whiphand run r1 — workflow 'cycle'",
                "whiphand run r2 \"Ship it\" — workflow 'cycle' (global)",
                "whiphand resume r1 — workflow 'cycle', from step 'execute' (iteration 2)",
                "whiphand resume r1 — workflow 'cycle'",
                "↷ step plan (reused)",
                "  ↷ step edit (reused)",
            ]
        );
    }

    #[test]
    fn attachments() {
        let c = capture();
        c.render(json!({
            "type": "run:start", "runId": "r1", "workflow": "feature",
            "attachments": [{ "name": "bug.png", "size": 1.2 * 1024.0 * 1024.0 }, { "name": "server.log", "size": 340 * 1024 }],
        }));
        assert_eq!(
            c.out(),
            [
                "whiphand run r1 — workflow 'feature'",
                "📎 bug.png 1.2 MB · server.log 340 KB"
            ]
        );
        // A dry run also names where each would have been copied.
        let c = Capture::new(RenderOptions {
            run_dir_of: Some(Box::new(|id| format!("/ws/.whiphand/runs/{id}"))),
            show_prompts: false,
        });
        c.render(json!({ "type": "run:start", "runId": "r1", "workflow": "feature", "attachments": [{ "name": "bug.png", "size": 12 }] }));
        assert_eq!(
            c.out()[1..],
            [
                "📎 bug.png 12 B".to_string(),
                format!(
                    "  → {}",
                    node_path::join(&["/ws/.whiphand/runs/r1", "attachments", "bug.png"])
                )
            ]
        );
    }

    #[test]
    fn stages() {
        let c = capture();
        c.render(json!({ "type": "stages:start", "id": "build", "total": 7 }));
        let item = json!({ "type": "stages:item", "id": "build", "index": 3, "total": 7, "stageId": "03-api", "title": "Add API routes", "attempt": 1 });
        c.render(item.clone());
        let mut retry = item;
        retry["attempt"] = 2.into();
        c.render(retry);
        c.render(json!({ "type": "stages:accepted", "id": "build", "stageId": "03-api" }));
        c.render(json!({ "type": "stages:accepted", "id": "other", "stageId": "01-x" }));
        c.render(json!({ "type": "stages:exhausted", "id": "build", "stageId": "03-api", "attempts": 3 }));
        c.render(json!({ "type": "stages:done", "id": "build", "completed": 7 }));
        assert_eq!(
            c.out(),
            [
                "▤ stages build (7 stages)",
                "▤ build — stage 3/7: Add API routes",
                "▤ build — stage 3/7: Add API routes (attempt 2)",
                "▤ build — stage 3/7 accepted",
                "▤ other — stage 01-x accepted",
                "▤ build — stage '03-api' rejected after 3 attempt(s), handed to a human",
                "▤ build finished 7 stages",
            ]
        );
    }

    #[test]
    fn a_loop_inside_a_stage_names_the_stage() {
        let c = capture();
        c.render(json!({ "type": "loop:start", "loopId": "cycle", "maxIterations": 3, "parentLoopId": "build", "parentIteration": 1, "parentStage": "01-schema" }));
        c.render(json!({ "type": "loop:start", "loopId": "cycle", "maxIterations": 3, "parentLoopId": "build", "parentIteration": 1, "parentStage": "02-api" }));
        c.render(
            json!({ "type": "loop:done", "loopId": "cycle", "iterations": 2, "passed": true }),
        );
        c.render(
            json!({ "type": "loop:done", "loopId": "cycle", "iterations": 3, "passed": false }),
        );
        assert_eq!(
            c.out(),
            [
                "↻ loop build/01-schema 1 › cycle (up to 3 iterations)",
                "↻ loop build/02-api 1 › cycle (up to 3 iterations)",
                "↻ cycle passed after 2 iteration(s)",
                "↻ cycle exhausted after 3 iteration(s)",
            ]
        );
    }

    #[test]
    fn degradations_are_held_until_the_run_ends() {
        let c = capture();
        c.render(json!({ "type": "run:start", "runId": "r1", "workflow": "w" }));
        c.render(json!({ "type": "run:degraded", "capability": "git-guard", "stepId": "look", "reason": "not a git repository: read-only tree assertion disabled" }));
        c.render(json!({ "type": "run:degraded", "capability": "process-containment", "reason": "the process guard (whiphand-job.exe) was not found" }));
        assert!(c.err().is_empty(), "nothing between steps");
        c.render(json!({ "type": "run:done", "runId": "r1", "ok": true }));
        assert_eq!(c.last(), "✔ run complete");
        assert_eq!(
            c.err(),
            [
                "  ⚠ degraded: Read-only tree guard off (not a git repository) [look] — not a git repository: read-only tree assertion disabled",
                "  ⚠ degraded: Process containment unavailable — the process guard (whiphand-job.exe) was not found",
            ]
        );
        // One that arrives after the end (teardown) is printed as it comes.
        c.render(json!({ "type": "run:degraded", "capability": "retention", "reason": "could not prune r0: EBUSY" }));
        assert_eq!(
            c.err().last().unwrap(),
            "  ⚠ degraded: Old run directories could not be pruned — could not prune r0: EBUSY"
        );
    }

    #[test]
    fn a_dry_run_shows_prompt_files_under_the_spawn_line() {
        let c = Capture::new(RenderOptions {
            run_dir_of: None,
            show_prompts: true,
        });
        c.render(json!({ "type": "step:spawn", "stepId": "a", "spec": {
            "argv": ["claude", "-p", "two words"],
            "files": [
                { "path": "/r/.a.prompt", "content": "line one\nline two" },
                { "path": "/r/a.harvest-prompt", "content": "h" },
                { "path": "/r/settings.json", "content": "{}" },
            ],
        } }));
        assert_eq!(
            c.out(),
            [
                "  $ claude -p \"two words\"",
                "  ┆ .a.prompt:",
                "  ┆   line one",
                "  ┆   line two",
                "  ┆ a.harvest-prompt:",
                "  ┆   h",
            ]
        );
    }
}
