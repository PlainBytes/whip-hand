//! A manual or approval step waiting on the human: the request core sends
//! (`ManualRequest` in apps/desktop/src/shared/types.ts), and the screen
//! that answers it. The labels follow the desktop's review/from-manual.ts.

use serde::Deserialize;
use serde_json::Value;
use whiphand_core::format::stage_label;
use whiphand_protocol::{FileComment, ManualChoice};

use super::detail::DiffState;
use super::input::Input;

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    /// `note` or `review`.
    pub kind: String,
    pub label: String,
    /// Choices that need the note.
    #[serde(default)]
    pub required_for: Vec<ManualChoice>,
    /// Per-file comments are offered.
    #[serde(default)]
    pub per_file: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct ArtifactRef {
    pub id: String,
    /// Workspace-relative, with `/`.
    pub path: String,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    #[serde(default)]
    pub artifacts: Vec<ArtifactRef>,
    /// Present when the step has `show_diff`; the screen shows the same
    /// change set as files (`getWorkingDiff`), which it can comment on.
    pub diff: Option<String>,
    pub diff_unavailable: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub title: String,
    pub index: u32,
    pub total: u32,
    pub attempt: u32,
    pub max_attempts: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub step_id: String,
    /// `manual` or `approval`.
    pub kind: String,
    pub title: String,
    pub instructions: String,
    pub choices: Vec<ManualChoice>,
    pub capture: Option<Capture>,
    #[serde(default)]
    pub context: Context,
    pub stage: Option<Stage>,
}

impl Request {
    pub fn parse(value: &Value) -> Result<Request, String> {
        serde_json::from_value(value.clone()).map_err(|e| format!("manualRequest: {e}"))
    }

    pub fn badge(&self) -> &'static str {
        if self.kind == "approval" {
            "Decision needed"
        } else {
            "Your turn"
        }
    }

    /// Where a step inside `stages` sits.
    pub fn subtitle(&self) -> Option<String> {
        let s = self.stage.as_ref()?;
        let mut parts = vec![stage_label(
            &s.index.to_string(),
            &s.total.to_string(),
            &s.title,
        )];
        if s.attempt > 1 {
            parts.push(match s.max_attempts {
                Some(max) => format!("attempt {} of {max}", s.attempt),
                None => format!("attempt {}", s.attempt),
            });
        }
        Some(parts.join(" · "))
    }

    fn reviewing(&self) -> bool {
        self.capture.as_ref().is_some_and(|c| c.kind == "review")
    }

    pub fn choice_label(&self, choice: ManualChoice) -> &'static str {
        match choice {
            ManualChoice::Continue => "Continue",
            ManualChoice::Retry if self.reviewing() => "Request changes",
            ManualChoice::Retry => "Retry",
            ManualChoice::Abort => "Abort run",
        }
    }

    pub fn choice_hint(&self, choice: ManualChoice) -> &'static str {
        match choice {
            ManualChoice::Continue => "Carry on to the next step.",
            ManualChoice::Retry if self.reviewing() => {
                "Send it back to the agent with your comments."
            }
            ManualChoice::Retry => "Go round the loop again.",
            ManualChoice::Abort => "Stop the run here.",
        }
    }
}

/// The key each choice is on, as the help and the screen spell it.
pub fn choice_key(choice: ManualChoice) -> char {
    match choice {
        ManualChoice::Continue => 'a',
        ManualChoice::Retry => 'b',
        ManualChoice::Abort => 'X',
    }
}

/// What the screen's keys move through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Focus {
    Note,
    /// An artifact of the context, by index: Enter pages it.
    Artifact(usize),
    /// A file of the diff, by index.
    File(usize),
}

/// The manual screen for one job's open request.
#[derive(Clone, Debug, PartialEq)]
pub struct Manual {
    pub job_id: String,
    pub run_id: Option<String>,
    pub workdir: String,
    pub request: Request,
    pub note: Input,
    /// Per-file comments, by path, in the order first left.
    pub comments: Vec<(String, Input)>,
    pub diff: Option<DiffState>,
    pub focus: Focus,
    pub editing: bool,
    /// Instructions scrolled by this many lines.
    pub scroll: u16,
    /// Sent; waiting for `manualResolved`.
    pub sent: Option<ManualChoice>,
    /// Asked "abort the run?"; `X` again answers.
    pub confirm_abort: bool,
}

impl Manual {
    pub fn new(
        job_id: String,
        run_id: Option<String>,
        workdir: String,
        request: Request,
    ) -> Manual {
        Manual {
            job_id,
            run_id,
            workdir,
            request,
            note: Input::new("", true),
            comments: Vec::new(),
            diff: None,
            focus: Focus::Note,
            editing: false,
            scroll: 0,
            sent: None,
            confirm_abort: false,
        }
    }

    pub fn wants_diff(&self) -> bool {
        self.request.context.diff.is_some()
    }

    pub fn files(&self) -> &[whiphand_protocol::WorkingDiffFile] {
        match &self.diff {
            Some(DiffState::Loaded(Some(d))) => &d.files,
            _ => &[],
        }
    }

    /// The comment on `path`, if one was left.
    pub fn comment(&self, path: &str) -> Option<&Input> {
        self.comments
            .iter()
            .find(|(p, _)| p == path)
            .map(|(_, i)| i)
    }

    /// The input the focus is on, made if it is a file's first comment.
    pub fn focused_input(&mut self) -> Option<&mut Input> {
        match self.focus {
            Focus::Note => Some(&mut self.note),
            Focus::Artifact(_) => None,
            Focus::File(i) => {
                let per_file = self.request.capture.as_ref().is_some_and(|c| c.per_file);
                let path = self.files().get(i)?.path.clone();
                if !per_file {
                    return None;
                }
                let at = match self.comments.iter().position(|(p, _)| *p == path) {
                    Some(at) => at,
                    None => {
                        self.comments.push((path, Input::new("", true)));
                        self.comments.len() - 1
                    }
                };
                Some(&mut self.comments[at].1)
            }
        }
    }

    /// Why `choice` cannot be sent yet.
    pub fn blocked(&self, choice: ManualChoice) -> Option<String> {
        let capture = self.request.capture.as_ref()?;
        (capture.required_for.contains(&choice) && self.note.is_blank()).then(|| {
            format!(
                "{} needs a {} first (i)",
                self.request.choice_label(choice),
                capture.label.to_lowercase()
            )
        })
    }

    /// The comments worth sending: not blank, in the order left.
    pub fn file_comments(&self) -> Vec<FileComment> {
        self.comments
            .iter()
            .filter(|(_, i)| !i.is_blank())
            .map(|(path, i)| FileComment {
                path: path.clone(),
                body: i.text().trim().to_string(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn review() -> Request {
        Request::parse(&json!({
            "stepId": "sign-off", "kind": "approval", "title": "Ship it?",
            "instructions": "Read the diff.", "choices": ["continue", "retry", "abort"],
            "capture": { "kind": "review", "label": "Feedback", "requiredFor": ["retry"], "perFile": true },
            "context": { "artifacts": [{ "id": "plan", "path": ".whiphand/runs/r1/plan.md" }], "diff": "diff --git a/x b/x\n" },
            "defaultChoice": "continue",
            "stage": { "stagesId": "s", "id": "two", "title": "Build", "index": 2, "total": 3, "attempt": 2, "maxAttempts": 3 },
        }))
        .unwrap()
    }

    #[test]
    fn a_review_reads_as_a_request_for_changes() {
        let r = review();
        assert_eq!(r.badge(), "Decision needed");
        assert_eq!(r.choice_label(ManualChoice::Retry), "Request changes");
        assert_eq!(
            r.subtitle().as_deref(),
            Some("stage 2 of 3 · Build · attempt 2 of 3")
        );
    }

    #[test]
    fn sending_back_needs_the_note_and_carries_file_comments() {
        let mut m = Manual::new("j1".into(), Some("r1".into()), "/w".into(), review());
        assert!(m.blocked(ManualChoice::Retry).unwrap().contains("feedback"));
        assert!(m.blocked(ManualChoice::Continue).is_none());
        m.note.set("Tighten the error handling.");
        assert!(m.blocked(ManualChoice::Retry).is_none());

        m.diff = Some(DiffState::Loaded(Some(
            serde_json::from_value(json!({ "files": [
                { "path": "src/a.rs", "status": "modified", "additions": 1, "deletions": 0, "binary": false },
                { "path": "src/b.rs", "status": "added", "additions": 3, "deletions": 0, "binary": false },
            ] }))
            .unwrap(),
        )));
        m.focus = Focus::File(1);
        m.focused_input().unwrap().set("Name this better.");
        m.focus = Focus::File(0);
        m.focused_input().unwrap();
        assert_eq!(
            m.file_comments(),
            [FileComment {
                path: "src/b.rs".into(),
                body: "Name this better.".into()
            }]
        );
    }
}
