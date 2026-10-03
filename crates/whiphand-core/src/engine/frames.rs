//! Frames and the identity of one execution (`execution-key.ts`'s
//! `frameRef`/`ancestorLoops`/`frameIdentity`, and the JS shapes the runner
//! builds frames in, which reach events through a manual request).

use crate::execution_key::{LoopRef, execution_key};
use crate::jsval::{JsObject, JsValue, ObjExt};
use crate::obj;
use crate::template::{Frame, Stage};

fn parent(f: &Frame) -> Option<&Frame> {
    match f {
        Frame::Loop(l) => l.parent.as_deref(),
        Frame::Stage(s) => s.parent.as_deref(),
    }
}

pub fn frame_id(f: &Frame) -> &str {
    match f {
        Frame::Loop(l) => &l.id,
        Frame::Stage(s) => &s.id,
    }
}

/// One frame as the loop-shaped ref every `outerLoops` entry is made of.
pub fn frame_ref(f: &Frame) -> LoopRef {
    match f {
        Frame::Loop(l) => LoopRef {
            id: l.id.clone(),
            iteration: l.iteration as f64,
            stage: None,
        },
        Frame::Stage(s) => LoopRef {
            id: s.id.clone(),
            iteration: s.attempt as f64,
            stage: Some(s.stage.id.clone()),
        },
    }
}

/// The frames enclosing `frame`, outermost first.
pub fn ancestor_loops(frame: Option<&Frame>) -> Vec<LoopRef> {
    let mut chain = Vec::new();
    let mut f = frame.and_then(parent);
    while let Some(fr) = f {
        chain.insert(0, frame_ref(fr));
        f = parent(fr);
    }
    chain
}

/// The tuple every emit site speaks: loopId/iteration, stage, outerLoops.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Identity {
    pub loop_id: Option<String>,
    pub iteration: Option<f64>,
    pub stage: Option<String>,
    pub outer_loops: Vec<LoopRef>,
}

pub fn frame_identity(frame: Option<&Frame>) -> Identity {
    let Some(f) = frame else {
        return Identity::default();
    };
    let r = frame_ref(f);
    Identity {
        loop_id: Some(r.id),
        iteration: Some(r.iteration),
        stage: r.stage,
        outer_loops: ancestor_loops(Some(f)),
    }
}

pub fn identity_key(step_id: &str, idn: &Identity) -> String {
    execution_key(
        step_id,
        idn.iteration,
        &idn.outer_loops,
        idn.stage.as_deref(),
    )
}

pub fn loop_ref_js(r: &LoopRef) -> JsValue {
    let mut o = obj! { "id" => r.id.as_str(), "iteration" => r.iteration };
    if let Some(s) = &r.stage {
        o.set("stage", s.as_str());
    }
    JsValue::Obj(o)
}

pub fn loop_refs_js(refs: &[LoopRef]) -> JsValue {
    JsValue::Arr(refs.iter().map(loop_ref_js).collect())
}

/// `executionFields`: the identity a step's start/skip events carry, absent parts left out.
pub fn execution_fields(idn: &Identity) -> JsObject {
    let mut o = JsObject::new();
    if let Some(l) = &idn.loop_id {
        o.set("loopId", l.as_str());
        o.set("iteration", idn.iteration);
    }
    if let Some(s) = &idn.stage {
        o.set("stage", s.as_str());
    }
    if !idn.outer_loops.is_empty() {
        o.set("outerLoops", loop_refs_js(&idn.outer_loops));
    }
    o
}

pub fn stage_js(s: &Stage) -> JsObject {
    obj! {
        "index" => s.index, "total" => s.total, "id" => s.id.as_str(), "title" => s.title.as_str(),
        "path" => s.path.as_str(),
    }
}

/// A frame as the runner builds it: `{ id, iteration, maxIterations, parent }`
/// for a loop, `{ kind: 'stages', id, stage, attempt, maxAttempts, parent }` for a stage.
pub fn frame_js(f: &Frame) -> JsValue {
    let parent = parent(f).map_or(JsValue::Undefined, frame_js);
    JsValue::Obj(match f {
        Frame::Loop(l) => obj! {
            "id" => l.id.as_str(), "iteration" => l.iteration, "maxIterations" => l.max_iterations, "parent" => parent,
        },
        Frame::Stage(s) => obj! {
            "kind" => "stages", "id" => s.id.as_str(), "stage" => stage_js(&s.stage), "attempt" => s.attempt,
            "maxAttempts" => s.max_attempts, "parent" => parent,
        },
    })
}
