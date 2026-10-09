//! A parsed workflow as the JS object `parseWorkflow` returns: zod rebuilds
//! every object in its schema's key order (the shared step fields first, then
//! `kind`, then the kind's own; `kind` first for loops and stages), with
//! absent optional fields left out. The run's `workflow.yaml` snapshot is that
//! object, stringified, so the order is the snapshot's.

use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::types::{
    AgentStep, Capture, CommandStep, ManualDefault, ManualStep, OnFindings, Step, Workflow,
    WorktreeSetting,
};

fn strings(v: &[String]) -> JsValue {
    JsValue::Arr(v.iter().map(JsValue::from).collect())
}

fn on_findings(o: OnFindings) -> &'static str {
    match o {
        OnFindings::Report => "report",
        OnFindings::Loop => "loop",
        OnFindings::Interactive => "interactive",
    }
}

fn base(
    o: &mut JsObject,
    id: &str,
    inputs: &Option<Vec<String>>,
    verdict: Option<bool>,
    enabled: Option<bool>,
) {
    o.set("id", id);
    if let Some(i) = inputs {
        o.set("inputs", strings(i));
    }
    if let Some(v) = verdict {
        o.set("verdict", v);
    }
    if let Some(e) = enabled {
        o.set("enabled", e);
    }
}

fn opt<T: Into<JsValue>>(o: &mut JsObject, key: &str, v: Option<T>) {
    if let Some(v) = v {
        o.set(key, v);
    }
}

fn agent(s: &AgentStep) -> JsObject {
    let mut o = JsObject::new();
    base(&mut o, &s.id, &s.inputs, s.verdict, s.enabled);
    o.set("kind", "agent");
    o.set("runner", s.runner.as_str());
    opt(&mut o, "model", s.model.clone());
    o.set("mode", s.mode.as_str());
    o.set("writes", s.writes);
    o.set("prompt", s.prompt.as_str());
    o.set("output", s.output.as_str());
    if let Some(p) = &s.allow_paths {
        o.set("allow_paths", strings(p));
    }
    opt(&mut o, "allow_commits", s.allow_commits);
    opt(&mut o, "effort", s.effort.map(|e| e.as_str()));
    opt(&mut o, "harvest_timeout_ms", s.harvest_timeout_ms);
    o
}

fn command(s: &CommandStep) -> JsObject {
    let mut o = JsObject::new();
    base(&mut o, &s.id, &s.inputs, s.verdict, s.enabled);
    o.set("kind", "command");
    o.set("run", s.run.as_str());
    opt(&mut o, "shell", s.shell.clone());
    opt(&mut o, "cwd", s.cwd.clone());
    if let Some(env) = &s.env {
        o.set(
            "env",
            JsObject::from_iter(env.iter().map(|(k, v)| (k.to_string(), JsValue::from(v)))),
        );
    }
    opt(&mut o, "timeout_ms", s.timeout_ms);
    if let Some(e) = &s.expect_exit {
        o.set(
            "expect_exit",
            JsValue::Arr(e.iter().map(|n| JsValue::from(*n)).collect()),
        );
    }
    opt(&mut o, "output", s.output.clone());
    o
}

fn manual(s: &ManualStep, kind: &str) -> JsObject {
    let mut o = JsObject::new();
    base(&mut o, &s.id, &s.inputs, s.verdict, s.enabled);
    o.set("kind", kind);
    o.set("title", s.title.as_str());
    o.set("instructions", s.instructions.as_str());
    opt(
        &mut o,
        "capture",
        s.capture.map(|c| match c {
            Capture::Note => "note",
            Capture::Review => "review",
        }),
    );
    opt(&mut o, "show_diff", s.show_diff);
    opt(
        &mut o,
        "default",
        s.default.map(|d| match d {
            ManualDefault::Continue => "continue",
            ManualDefault::Abort => "abort",
        }),
    );
    opt(&mut o, "output", s.output.clone());
    o
}

pub fn step_to_js(step: &Step) -> JsValue {
    JsValue::Obj(match step {
        Step::Agent(s) => agent(s),
        Step::Command(s) => command(s),
        Step::Manual(s) => manual(s, "manual"),
        Step::Approval(s) => manual(s, "approval"),
        Step::Loop(l) => {
            let mut o = JsObject::new();
            o.set("kind", "loop");
            o.set("id", l.id.as_str());
            o.set(
                "steps",
                JsValue::Arr(l.steps.iter().map(step_to_js).collect()),
            );
            o.set("until", l.until.as_str());
            opt(&mut o, "max_iterations", l.max_iterations);
            opt(&mut o, "on_exhausted", l.on_exhausted.map(on_findings));
            opt(&mut o, "enabled", l.enabled);
            o
        }
        Step::Stages(s) => {
            let mut o = JsObject::new();
            o.set("kind", "stages");
            o.set("id", s.id.as_str());
            o.set("items", s.items.as_str());
            o.set(
                "steps",
                JsValue::Arr(s.steps.iter().map(step_to_js).collect()),
            );
            opt(&mut o, "max_retries", s.max_retries);
            opt(&mut o, "enabled", s.enabled);
            o
        }
    })
}

fn worktree_to_js(setting: &WorktreeSetting) -> JsValue {
    match setting {
        WorktreeSetting::Disabled => JsValue::from(false),
        WorktreeSetting::Enabled { base, branch } if base.is_none() && branch.is_none() => {
            JsValue::from(true)
        }
        WorktreeSetting::Enabled { base, branch } => {
            let mut o = JsObject::new();
            opt(&mut o, "base", base.clone());
            opt(&mut o, "branch", branch.clone());
            JsValue::Obj(o)
        }
    }
}

pub fn workflow_to_js(w: &Workflow) -> JsValue {
    let mut o = JsObject::new();
    o.set("name", w.name.as_str());
    opt(&mut o, "description", w.description.clone());
    if let Some(inputs) = &w.inputs {
        let mut rec = JsObject::new();
        for (k, def) in inputs.iter() {
            let mut d = JsObject::new();
            d.set("required", def.required);
            opt(&mut d, "prompt", def.prompt.clone());
            opt(&mut d, "default", def.default.clone());
            opt(&mut d, "remember", def.remember);
            opt(&mut d, "multiline", def.multiline);
            rec.set(k, d);
        }
        o.set("inputs", rec);
    }
    opt(&mut o, "on_findings", w.on_findings.map(on_findings));
    if let Some(setting) = &w.worktree {
        o.set("worktree", worktree_to_js(setting));
    }
    o.set(
        "steps",
        JsValue::Arr(w.steps.iter().map(step_to_js).collect()),
    );
    JsValue::Obj(o)
}
