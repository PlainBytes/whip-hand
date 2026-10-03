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
    use std::rc::Rc;

    use super::*;
    use whiphand_core::obj;

    fn capture(opts: RenderOptions) -> (Renderer, Rc<RefCell<Vec<String>>>) {
        let lines = Rc::new(RefCell::new(Vec::new()));
        let (o, e) = (lines.clone(), lines.clone());
        let now = Rc::new(RefCell::new(1000.0));
        let sinks = Sinks {
            out: Box::new(move |l| o.borrow_mut().push(format!("out {l}"))),
            err: Box::new(move |l| e.borrow_mut().push(format!("err {l}"))),
            now: Box::new(move || {
                let mut n = now.borrow_mut();
                *n += 61_000.0;
                *n
            }),
        };
        (Renderer::new(sinks, opts), lines)
    }

    #[test]
    fn headless_step_summary_and_degradations() {
        let (r, lines) = capture(RenderOptions::default());
        r.render(&obj! { "type" => "run:start", "runId" => "r1", "workflow" => "w", "name" => "Ship", "source" => "global" });
        r.render(&obj! { "type" => "step:start", "stepId" => "a", "kind" => "agent", "runner" => "claude", "model" => "", "mode" => "headless" });
        r.render(&obj! { "type" => "step:progress", "stepId" => "a", "progress" => obj! { "kind" => "usage", "turns" => 3.0, "costUsd" => 0.125 } });
        r.render(&obj! { "type" => "step:progress", "stepId" => "a", "progress" => obj! { "kind" => "tool", "tool" => "Read", "target" => "x.ts" } });
        r.render(&obj! { "type" => "step:done", "stepId" => "a", "exitCode" => 0.0 });
        r.render(&obj! { "type" => "run:degraded", "capability" => "process-containment", "reason" => "no job" });
        r.render(&obj! { "type" => "run:done", "ok" => true });
        let got = lines.borrow().clone();
        assert_eq!(
            got[0],
            "out whiphand run r1 \"Ship\" — workflow 'w' (global)"
        );
        assert_eq!(got[1], "out → step a (claude, headless)");
        assert_eq!(got[2], "out   Read x.ts");
        assert_eq!(got[3], "out   3 turns · 1m 1s · $0.13");
        assert_eq!(got[4], "out ✔ run complete");
        assert!(got[5].starts_with("err   ⚠ degraded: "), "{got:?}");
    }

    #[test]
    fn prompt_files() {
        assert!(is_prompt_file("/r/.step.prompt"));
        assert!(is_prompt_file("/r/a.harvest-prompt"));
        assert!(!is_prompt_file("/r/aprompt"));
    }
}
