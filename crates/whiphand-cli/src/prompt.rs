//! The CLI's half of the "ask a human" seam (`prompt.ts`). Core builds the
//! question and never touches a terminal; this is the terminal. Everything
//! here writes to stderr, so `whiphand run --json` keeps stdout pure NDJSON
//! even while a step waits on somebody.

use std::future::Future;
use std::io::{BufRead, IsTerminal};
use std::pin::Pin;

use tokio_util::sync::CancellationToken;
use whiphand_core::engine::manual::ManualResponse;
use whiphand_core::js::{Record, is_js_whitespace};
use whiphand_core::jsval::{JsObject, JsValue, ObjExt};
use whiphand_core::types::Workflow;

use crate::io::err_raw;

const AUTO_NOTE: &str = "(auto-approved by --yes; no note provided)";

type ReadLine = Box<dyn Fn() -> Pin<Box<dyn Future<Output = Option<String>>>>>;

pub struct Prompter {
    /// `--yes`: resolve manual steps to their default instead of asking.
    pub yes: bool,
    pub is_tty: bool,
    write: Box<dyn Fn(&str)>,
    read: ReadLine,
}

/// One line from the real stdin, read off the runtime thread. `None` at EOF.
fn read_stdin_line() -> Pin<Box<dyn Future<Output = Option<String>>>> {
    Box::pin(async {
        tokio::task::spawn_blocking(|| {
            let mut line = String::new();
            match std::io::stdin().lock().read_line(&mut line) {
                Ok(0) | Err(_) => None,
                Ok(_) => Some(line),
            }
        })
        .await
        .ok()
        .flatten()
    })
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

fn s(v: &JsValue) -> String {
    v.to_js_string()
}

impl Prompter {
    /// The real terminal. `json` runs never prompt: their stdin is not a person.
    pub fn terminal(yes: bool, json: bool) -> Self {
        Prompter {
            yes,
            is_tty: !json && std::io::stdin().is_terminal(),
            write: Box::new(err_raw),
            read: Box::new(read_stdin_line),
        }
    }

    #[cfg(test)]
    pub fn scripted(yes: bool, is_tty: bool, answers: Vec<&str>, out: Box<dyn Fn(&str)>) -> Self {
        let answers = std::rc::Rc::new(std::cell::RefCell::new(
            answers
                .into_iter()
                .map(|a| format!("{a}\n"))
                .collect::<std::collections::VecDeque<_>>(),
        ));
        Prompter {
            yes,
            is_tty,
            write: out,
            read: Box::new(move || {
                let next = answers.borrow_mut().pop_front();
                Box::pin(async move { next })
            }),
        }
    }

    async fn ask(&self, question: &str, cancel: &CancellationToken) -> Result<String, String> {
        (self.write)(question);
        tokio::select! {
            line = (self.read)() => match line {
                // stdin ran out mid-question: a piped run that was expected to be interactive.
                None => Err("input ended while waiting for an answer".into()),
                Some(l) => Ok(js_trim(&l).to_string()),
            },
            () = cancel.cancelled() => Err("cancelled".into()),
        }
    }

    fn render_request(&self, request: &JsObject) {
        let w = &self.write;
        let heading = if request.str_prop("kind") == Some("approval") {
            "Decision"
        } else {
            "Manual step"
        };
        w(&format!("\n── {heading}: {}\n", s(request.prop("title"))));
        if let Some(stage) = request.prop("stage").as_obj() {
            let attempt = stage.prop("attempt").as_f64().unwrap_or(1.0);
            w(&format!(
                "   stage {}/{} '{}' of '{}'{}\n",
                s(stage.prop("index")),
                s(stage.prop("total")),
                s(stage.prop("title")),
                s(stage.prop("stagesId")),
                if attempt > 1.0 {
                    format!(" (attempt {})", s(stage.prop("attempt")))
                } else {
                    String::new()
                }
            ));
        } else if let Some(l) = request.prop("loop").as_obj() {
            w(&format!(
                "   iteration {}/{} of '{}'\n",
                s(l.prop("iteration")),
                s(l.prop("maxIterations")),
                s(l.prop("id"))
            ));
        }
        w(&format!(
            "\n{}\n",
            js_trim_end(&s(request.prop("instructions")))
        ));
        let context = request.prop("context");
        let artifacts = context.get("artifacts").as_arr().unwrap_or(&[]);
        if !artifacts.is_empty() {
            w("\nArtifacts to read first:\n");
            for a in artifacts {
                w(&format!("  - {}: {}\n", s(a.get("id")), s(a.get("path"))));
            }
        }
        if let Some(diff) = context.get("diff").as_str().filter(|d| !d.is_empty()) {
            w(&format!("\nWorking tree diff:\n{}\n", js_trim_end(diff)));
        }
    }

    /// `Frontend.runManual`.
    pub async fn run_manual(
        &self,
        request: &JsObject,
        cancel: &CancellationToken,
    ) -> Result<ManualResponse, String> {
        let default_choice = s(request.prop("defaultChoice"));
        let capture = request.prop("capture").as_obj();
        let required_for = |choice: &str| {
            capture
                .and_then(|c| c.prop("requiredFor").as_arr())
                .is_some_and(|r| r.iter().any(|v| v.as_str() == Some(choice)))
        };

        if !self.is_tty {
            if !self.yes {
                return Err(format!(
                    "manual step '{}' needs a human — run it on a terminal, or pass --yes \
                     to take its default ('{default_choice}')",
                    s(request.prop("stepId"))
                ));
            }
            (self.write)(&format!(
                "⚠ auto-resolving {} step '{}' as '{default_choice}' (--yes)\n",
                s(request.prop("kind")),
                s(request.prop("stepId"))
            ));
            return Ok(ManualResponse {
                note: required_for(&default_choice).then(|| AUTO_NOTE.to_string()),
                choice: default_choice,
                ..ManualResponse::default()
            });
        }

        self.render_request(request);

        let choices: Vec<String> = request
            .prop("choices")
            .as_arr()
            .unwrap_or(&[])
            .iter()
            .map(s)
            .collect();
        let menu = choices
            .iter()
            .map(|c| {
                let mut chars = c.chars();
                let first = chars.next().map(String::from).unwrap_or_default();
                format!("[{first}]{}", chars.as_str())
            })
            .collect::<Vec<_>>()
            .join(" / ");

        let choice = loop {
            let answer = self
                .ask(&format!("\n{menu} (default: {default_choice}) > "), cancel)
                .await?;
            let Some(first) = answer.chars().next() else {
                break default_choice.clone();
            };
            let key: String = first.to_lowercase().collect();
            // A later choice with the same first letter wins, as the Map did.
            match choices.iter().rev().find(|c| c.starts_with(&key)) {
                Some(c) => break c.clone(),
                None => (self.write)(&format!("  not one of: {}\n", choices.join(", "))),
            }
        };

        if choice != "abort"
            && let Some(capture) = capture
        {
            let label = s(capture.prop("label"));
            let required = required_for(&choice);
            let mut note = String::new();
            while note.is_empty() {
                note = self.ask(&format!("{label}: "), cancel).await?;
                if note.is_empty() && !required {
                    break;
                }
                if note.is_empty() {
                    (self.write)("  a note is required for this step\n");
                }
            }
            return Ok(ManualResponse {
                choice,
                note: Some(note),
                ..ManualResponse::default()
            });
        }
        Ok(ManualResponse {
            choice,
            ..ManualResponse::default()
        })
    }

    /// Prompts for every missing required input, with the input's `prompt:` text.
    pub async fn missing_inputs(
        &self,
        workflow: &Workflow,
        given: Record<String>,
    ) -> Result<Record<String>, String> {
        let mut resolved = given;
        if !self.is_tty {
            return Ok(resolved);
        }
        let missing: Vec<(String, String)> = workflow
            .inputs
            .iter()
            .flat_map(|i| i.iter())
            .filter(|(k, def)| resolved.get(k).is_none() && def.default.is_none() && def.required)
            .map(|(k, def)| {
                (
                    k.to_string(),
                    def.prompt.clone().unwrap_or_else(|| format!("input '{k}'")),
                )
            })
            .collect();
        let never = CancellationToken::new();
        for (key, label) in missing {
            let mut value = String::new();
            while value.is_empty() {
                value = self.ask(&format!("{label} > "), &never).await?;
                if value.is_empty() {
                    (self.write)(&format!("  '{key}' is required\n"));
                }
            }
            resolved.insert(key, value);
        }
        Ok(resolved)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use serde_json::json;
    use whiphand_core::jsval::from_json;
    use whiphand_core::schema::parse_workflow;

    use super::*;

    type Sink = (Box<dyn Fn(&str)>, Rc<RefCell<String>>);

    fn sink() -> Sink {
        let buf = Rc::new(RefCell::new(String::new()));
        let b = buf.clone();
        (Box::new(move |t| b.borrow_mut().push_str(t)), buf)
    }

    fn request(extra: serde_json::Value) -> JsObject {
        let mut base = json!({
            "stepId": "sign", "kind": "approval", "title": "Ship it?",
            "instructions": "Review the diff before pushing.",
            "choices": ["continue", "abort"],
            "context": { "artifacts": [{ "id": "review", "path": "/r/findings.md" }] },
            "defaultChoice": "continue",
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        match from_json(&base) {
            JsValue::Obj(o) => o,
            _ => unreachable!(),
        }
    }

    /// A terminal that types `answers` in turn; returns the answer and what was written.
    async fn ask(answers: Vec<&str>, req: JsObject) -> (Result<ManualResponse, String>, String) {
        let (out, buf) = sink();
        let p = Prompter::scripted(false, true, answers, out);
        let got = p.run_manual(&req, &CancellationToken::new()).await;
        let text = buf.borrow().clone();
        (got, text)
    }

    fn choice(c: &str) -> ManualResponse {
        ManualResponse {
            choice: c.into(),
            ..ManualResponse::default()
        }
    }

    fn noted(c: &str, note: &str) -> ManualResponse {
        ManualResponse {
            choice: c.into(),
            note: Some(note.into()),
            ..ManualResponse::default()
        }
    }

    const NOTE: &str = r#"{ "kind": "note", "label": "Release note", "requiredFor": ["continue"], "perFile": false }"#;
    const REVIEW: &str =
        r#"{ "kind": "review", "label": "Feedback", "requiredFor": ["retry"], "perFile": true }"#;

    fn cap(spec: &str) -> serde_json::Value {
        serde_json::from_str(spec).unwrap()
    }

    #[tokio::test]
    async fn without_a_terminal_a_gate_needs_yes() {
        let (out, _) = sink();
        let p = Prompter::scripted(false, false, vec![], out);
        let err = p
            .run_manual(&request(json!({})), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(err.contains("'sign'") && err.contains("--yes"), "{err}");
    }

    #[tokio::test]
    async fn yes_takes_the_default_and_says_so() {
        let (out, buf) = sink();
        let p = Prompter::scripted(true, false, vec![], out);
        let never = CancellationToken::new();
        assert_eq!(
            p.run_manual(&request(json!({})), &never).await.unwrap(),
            choice("continue")
        );
        assert!(buf.borrow().contains("auto-resolving") && buf.borrow().contains("'sign'"));
        let abort = request(json!({ "defaultChoice": "abort" }));
        assert_eq!(p.run_manual(&abort, &never).await.unwrap(), choice("abort"));
        // A placeholder note where the default needs one, and none where it does not.
        let note = p
            .run_manual(&request(json!({ "capture": cap(NOTE) })), &never)
            .await
            .unwrap();
        assert!(note.note.unwrap().contains("--yes"));
        let review = p
            .run_manual(&request(json!({ "capture": cap(REVIEW) })), &never)
            .await
            .unwrap();
        assert_eq!(review.note, None);
    }

    #[tokio::test]
    async fn on_a_terminal_it_renders_the_question_and_reads_a_choice() {
        let (got, text) = ask(vec!["a"], request(json!({}))).await;
        assert_eq!(got.unwrap(), choice("abort"));
        assert!(text.contains("── Decision: Ship it?\n"));
        assert!(text.contains("Review the diff before pushing."));
        assert!(
            text.contains("  - review: /r/findings.md\n"),
            "artifact paths are shown"
        );
        assert!(text.contains("\n[c]ontinue / [a]bort (default: continue) > "));
    }

    #[tokio::test]
    async fn an_empty_answer_takes_the_default_and_a_wrong_one_is_re_asked() {
        assert_eq!(
            ask(vec![""], request(json!({}))).await.0.unwrap(),
            choice("continue")
        );
        let (got, text) = ask(vec!["zzz", "C"], request(json!({}))).await;
        assert_eq!(got.unwrap(), choice("continue"));
        assert!(text.contains("  not one of: continue, abort\n"));
    }

    #[tokio::test]
    async fn a_stage_gate_names_the_stage_not_the_loop() {
        let stage = json!({ "stagesId": "build", "id": "03-api", "title": "Add API routes", "index": 3, "total": 7, "attempt": 1 });
        let (_, text) = ask(
            vec!["c"],
            request(json!({ "loop": { "id": "fix", "iteration": 2, "maxIterations": 3 }, "stage": stage })),
        )
        .await;
        assert!(
            text.contains("   stage 3/7 'Add API routes' of 'build'\n"),
            "{text}"
        );
        assert!(!text.contains("iteration 2/3"));
        let mut retried = stage;
        retried["attempt"] = 2.into();
        let (_, text) = ask(vec!["c"], request(json!({ "stage": retried }))).await;
        assert!(text.contains("of 'build' (attempt 2)\n"));
        let (_, text) = ask(
            vec!["c"],
            request(json!({ "loop": { "id": "fix", "iteration": 2, "maxIterations": 3 } })),
        )
        .await;
        assert!(text.contains("   iteration 2/3 of 'fix'\n"));
    }

    #[tokio::test]
    async fn captures() {
        let three = json!(["continue", "retry", "abort"]);
        // A required note will not take an empty answer.
        let (got, text) = ask(
            vec!["c", "", "shipped it"],
            request(json!({ "capture": cap(NOTE) })),
        )
        .await;
        assert_eq!(got.unwrap(), noted("continue", "shipped it"));
        assert!(text.contains("Release note: "));
        assert!(text.contains("  a note is required for this step\n"));
        // Asked on retry too, not only continue.
        let (got, _) = ask(
            vec!["r", "send it back"],
            request(json!({ "choices": three, "capture": cap(REVIEW) })),
        )
        .await;
        assert_eq!(got.unwrap(), noted("retry", "send it back"));
        // An optional note may be left empty.
        let (got, _) = ask(
            vec!["c", ""],
            request(json!({ "choices": three, "capture": cap(REVIEW) })),
        )
        .await;
        assert_eq!(got.unwrap(), noted("continue", ""));
        // Never on abort.
        let (got, _) = ask(
            vec!["a"],
            request(json!({ "choices": three, "capture": cap(REVIEW) })),
        )
        .await;
        assert_eq!(got.unwrap(), choice("abort"));
    }

    #[tokio::test]
    async fn the_diff_is_shown_when_asked_for() {
        let (_, text) = ask(
            vec!["c"],
            request(json!({ "context": { "artifacts": [], "diff": "+++ b/src/x.ts\n\n" } })),
        )
        .await;
        assert!(text.contains("\nWorking tree diff:\n+++ b/src/x.ts\n"));
    }

    #[tokio::test]
    async fn eof_and_cancel_end_the_question() {
        let (got, _) = ask(vec![], request(json!({}))).await;
        assert_eq!(got.unwrap_err(), "input ended while waiting for an answer");
        let (out, _) = sink();
        let p = Prompter {
            yes: false,
            is_tty: true,
            write: out,
            read: Box::new(|| Box::pin(std::future::pending())),
        };
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert_eq!(
            p.run_manual(&request(json!({})), &cancel)
                .await
                .unwrap_err(),
            "cancelled"
        );
    }

    fn workflow() -> Workflow {
        parse_workflow(
            "name: r\ninputs:\n  feature: { required: true, prompt: What are we building? }\n  branch: { required: false }\n  env: { required: true, default: dev }\nsteps:\n  - id: a\n    kind: command\n    run: \"true\"\n",
        )
        .unwrap()
    }

    #[tokio::test]
    async fn missing_required_inputs_are_prompted_for() {
        let (out, buf) = sink();
        let p = Prompter::scripted(false, true, vec!["", "oauth"], out);
        let got = p.missing_inputs(&workflow(), Record::new()).await.unwrap();
        assert_eq!(got.get("feature").map(String::as_str), Some("oauth"));
        assert_eq!(got.len(), 1);
        assert_eq!(
            buf.borrow().as_str(),
            "What are we building? >   'feature' is required\nWhat are we building? > "
        );
    }

    #[tokio::test]
    async fn given_defaulted_or_optional_inputs_are_never_asked() {
        let (out, buf) = sink();
        let p = Prompter::scripted(false, true, vec![], out);
        let mut given = Record::new();
        given.insert("feature".to_string(), "given".to_string());
        let got = p.missing_inputs(&workflow(), given).await.unwrap();
        assert_eq!(got.len(), 1);
        assert!(buf.borrow().is_empty());
        // Without a terminal nothing is asked: the engine reports the miss.
        let (out, _) = sink();
        let p = Prompter::scripted(false, false, vec![], out);
        assert!(
            p.missing_inputs(&workflow(), Record::new())
                .await
                .unwrap()
                .is_empty()
        );
    }
}
