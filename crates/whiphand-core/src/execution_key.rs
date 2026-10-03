//! The identity of one *execution*, from `execution-key.ts`: the parts the
//! run store matches manifest rows by.

use crate::jsval::{JsValue, ObjExt};

/// One frame of the `outerLoops` chain.
#[derive(Clone, Debug, PartialEq)]
pub struct LoopRef {
    pub id: String,
    pub iteration: f64,
    pub stage: Option<String>,
}

/// The string key of one execution. With no outer loops, iteration 1 (or
/// absent) is dropped; once there is an outer loop every segment carries its
/// iteration; a stage segment is never bare.
pub fn execution_key(
    step_id: &str,
    iteration: Option<f64>,
    outer_loops: &[LoopRef],
    stage: Option<&str>,
) -> String {
    let bare = outer_loops.is_empty();
    let segment = |id: &str, n: Option<f64>, s: Option<&str>| -> String {
        let n_text = crate::js::number_to_string(n.unwrap_or(1.0));
        if let Some(s) = s {
            return format!("{id}@{s}#{n_text}");
        }
        if bare && (n.is_none() || n == Some(1.0)) {
            id.to_string()
        } else {
            format!("{id}#{n_text}")
        }
    };
    let prefix: Vec<String> = outer_loops
        .iter()
        .map(|l| segment(&l.id, Some(l.iteration), l.stage.as_deref()))
        .collect();
    let own = segment(step_id, iteration, stage);
    if prefix.is_empty() {
        own
    } else {
        format!("{}/{own}", prefix.join("/"))
    }
}

/// `sameLoopRefs` over two `outerLoops` values as JS holds them: absent is
/// empty, and entries agree on id, iteration and stage.
pub fn same_loop_refs(a: &JsValue, b: &JsValue) -> bool {
    let aa = a.as_arr().unwrap_or(&[]);
    let bb = b.as_arr().unwrap_or(&[]);
    aa.len() == bb.len()
        && aa.iter().zip(bb).all(|(x, y)| {
            let (Some(x), Some(y)) = (x.as_obj(), y.as_obj()) else {
                return false;
            };
            x.prop("id") == y.prop("id")
                && x.prop("iteration") == y.prop("iteration")
                && x.prop("stage") == y.prop("stage")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        assert_eq!(execution_key("a", None, &[], None), "a");
        assert_eq!(execution_key("a", Some(2.0), &[], None), "a#2");
        assert_eq!(execution_key("a", None, &[], Some("01")), "a@01#1");
        let outer = [LoopRef {
            id: "o".into(),
            iteration: 2.0,
            stage: None,
        }];
        assert_eq!(execution_key("a", Some(1.0), &outer, None), "o#2/a#1");
    }
}
