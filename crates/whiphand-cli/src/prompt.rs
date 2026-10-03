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

    use super::*;
    use whiphand_core::adapters::common::strings;
    use whiphand_core::obj;

    fn request() -> JsObject {
        obj! {
            "stepId" => "gate", "kind" => "approval", "title" => "Ship?", "instructions" => "Look.\n",
            "choices" => strings(&["continue".into(), "retry".into(), "abort".into()]),
            "capture" => obj! { "kind" => "review", "label" => "Feedback", "requiredFor" => strings(&["retry".into()]) },
            "context" => obj! { "artifacts" => JsValue::Arr(vec![]) },
            "defaultChoice" => "continue",
        }
    }

    type Sink = (Box<dyn Fn(&str)>, Rc<RefCell<String>>);

    fn sink() -> Sink {
        let buf = Rc::new(RefCell::new(String::new()));
        let b = buf.clone();
        (Box::new(move |t| b.borrow_mut().push_str(t)), buf)
    }

    #[tokio::test]
    async fn asks_until_answered_and_requires_a_note() {
        let (out, buf) = sink();
        let p = Prompter::scripted(false, true, vec!["x", "R", "", "redo"], out);
        let got = p
            .run_manual(&request(), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(got.choice, "retry");
        assert_eq!(got.note.as_deref(), Some("redo"));
        let text = buf.borrow();
        assert!(text.contains("── Decision: Ship?\n\nLook.\n"), "{text}");
        assert!(text.contains("[c]ontinue / [r]etry / [a]bort (default: continue) > "));
        assert!(text.contains("  not one of: continue, retry, abort\n"));
        assert!(text.contains("  a note is required for this step\n"));
    }

    #[tokio::test]
    async fn unattended() {
        let (out, buf) = sink();
        let p = Prompter::scripted(false, false, vec![], out);
        let err = p
            .run_manual(&request(), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(err.contains("needs a human"), "{err}");
        let (out, _) = sink();
        let p = Prompter::scripted(true, false, vec![], out);
        let got = p
            .run_manual(&request(), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(got.choice, "continue");
        assert_eq!(got.note, None);
        assert!(buf.borrow().is_empty());
    }

    #[tokio::test]
    async fn eof_is_reported() {
        let (out, _) = sink();
        let p = Prompter::scripted(false, true, vec![], out);
        let err = p
            .run_manual(&request(), &CancellationToken::new())
            .await
            .unwrap_err();
        assert_eq!(err, "input ended while waiting for an answer");
    }
}
