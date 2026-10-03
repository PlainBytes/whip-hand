//! `attachments.ts` and `engine/attachments.ts`: files attached to a run at
//! start. Validated before the run directory exists (a bad invocation must
//! not leave an empty run behind), copied into `<runDir>/attachments/` once
//! it does.

use std::path::Path;

use crate::format::format_bytes;
use crate::jsval::JsValue;
use crate::node_path;
use crate::obj;
use crate::segment::validate_segment;
use crate::steps::{disabled_ids, flatten_steps};
use crate::types::{ATTACHMENTS_REF, Workflow};

/// What is attached: a file by path, or bytes that never had one.
#[derive(Clone, Debug)]
pub enum AttachmentSource {
    Path(String),
    Pasted { name: String, bytes: Vec<u8> },
}

/// One attachment that passed validation.
#[derive(Clone, Debug)]
pub struct PlannedAttachment {
    pub name: String,
    /// Run-dir-relative: `attachments/<name>`.
    pub path: String,
    pub size: u64,
    /// The original absolute path, or `pasted`.
    pub source: String,
    pub from: AttachmentSource,
}

impl PlannedAttachment {
    /// The manifest's record: `{ name, path, size, source }`.
    pub fn record(&self) -> JsValue {
        JsValue::Obj(obj! {
            "name" => self.name.as_str(), "path" => self.path.as_str(), "size" => self.size,
            "source" => self.source.as_str(),
        })
    }
}

/// Whether a step that will actually run names `attachments` in its inputs.
pub fn consumes_attachments(workflow: &Workflow) -> bool {
    let disabled = disabled_ids(&workflow.steps);
    flatten_steps(&workflow.steps).iter().any(|f| {
        !f.step.is_container()
            && !disabled.contains(f.step.id())
            && f.step.inputs().iter().any(|i| i == ATTACHMENTS_REF)
    })
}

pub fn unused_attachments_message(count: usize) -> String {
    format!(
        "{count} file{} attached, but no step reads `{ATTACHMENTS_REF}`.\nAdd it to a step's inputs, e.g.\n  - id: plan\n    inputs: [{ATTACHMENTS_REF}]",
        if count == 1 { "" } else { "s" }
    )
}

/// A name safe as one file inside `attachments/`: no directories, nothing
/// outside `[A-Za-z0-9._-]` (per UTF-16 unit, as the JS regex replaces), no
/// leading or trailing dots, and not a reserved device name.
pub fn sanitize_attachment_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut cleaned = String::new();
    for c in base.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            cleaned.push(c);
        } else {
            cleaned.push_str(&"-".repeat(c.len_utf16()));
        }
    }
    let cleaned = cleaned.trim_start_matches('.').trim_end_matches('.');
    let name = if cleaned.is_empty() {
        "attachment".to_string()
    } else {
        cleaned.to_string()
    };
    if validate_segment(&name).is_ok() {
        name
    } else {
        format!("attachment-{name}")
    }
}

fn split_extension(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(dot) if dot > 0 => (name[..dot].to_string(), name[dot..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// The final name of every attached file, unique case-insensitively.
pub fn attachment_names(sources: &[AttachmentSource]) -> Vec<String> {
    let mut taken = std::collections::HashSet::new();
    let mut pasted = 0;
    sources
        .iter()
        .map(|source| {
            let wanted = match source {
                AttachmentSource::Path(p) => sanitize_attachment_name(p),
                AttachmentSource::Pasted { name, .. } => {
                    pasted += 1;
                    let (_, ext) = split_extension(&sanitize_attachment_name(name));
                    format!("pasted-{pasted}{ext}")
                }
            };
            let (stem, ext) = split_extension(&wanted);
            let mut name = wanted.clone();
            let mut n = 2;
            while taken.contains(&name.to_lowercase()) {
                name = format!("{stem}-{n}{ext}");
                n += 1;
            }
            taken.insert(name.to_lowercase());
            name
        })
        .collect()
}

const MB: f64 = 1024.0 * 1024.0;

fn too_big(label: &str, size: u64, max_mb: f64) -> String {
    format!(
        "attachment {label} is {}, over the {} MB limit (raise runs.max_attachment_mb to allow it)",
        format_bytes(size as f64),
        crate::js::number_to_string(max_mb)
    )
}

fn size_of(path: &str) -> Result<u64, String> {
    if !node_path::is_absolute(path) {
        return Err(format!("attachment path must be absolute: {path}"));
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return Err(format!("attachment not found: {path}"));
    };
    if meta.is_dir() {
        return Err(format!("attachment is a directory, not a file: {path}"));
    }
    if !meta.is_file() {
        return Err(format!("attachment is not a regular file: {path}"));
    }
    if std::fs::File::open(path).is_err() {
        return Err(format!("attachment is not readable: {path}"));
    }
    Ok(meta.len())
}

/// Phase 1: every reason to refuse the files, from `stat` alone. The error
/// is the problem list (an `AttachmentError` in TS).
pub fn validate_attachments(
    sources: &[AttachmentSource],
    workflow: &Workflow,
    max_mb: f64,
) -> Result<Vec<PlannedAttachment>, Vec<String>> {
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    let names = attachment_names(sources);
    let mut problems = Vec::new();
    let mut planned = Vec::new();
    for (source, name) in sources.iter().zip(names) {
        let size = match source {
            AttachmentSource::Path(p) => match size_of(p) {
                Err(problem) => {
                    problems.push(problem);
                    continue;
                }
                Ok(size) if size as f64 > max_mb * MB => {
                    problems.push(too_big(p, size, max_mb));
                    continue;
                }
                Ok(size) => size,
            },
            AttachmentSource::Pasted { bytes, .. } => {
                let size = bytes.len() as u64;
                if size as f64 > max_mb * MB {
                    problems.push(too_big(&format!("'{name}'"), size, max_mb));
                    continue;
                }
                size
            }
        };
        planned.push(PlannedAttachment {
            path: format!("{ATTACHMENTS_REF}/{name}"),
            name,
            size,
            source: match source {
                AttachmentSource::Path(p) => p.clone(),
                AttachmentSource::Pasted { .. } => "pasted".into(),
            },
            from: source.clone(),
        });
    }
    if !consumes_attachments(workflow) {
        problems.push(unused_attachments_message(sources.len()));
    }
    if problems.is_empty() {
        Ok(planned)
    } else {
        Err(problems)
    }
}

/// Phase 2: copies the files into the run, refusing to overwrite.
pub fn copy_attachments(run_dir: &str, planned: &[PlannedAttachment]) -> std::io::Result<()> {
    if planned.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(node_path::join(&[run_dir, ATTACHMENTS_REF]))?;
    for a in planned {
        let dest = node_path::join(&[run_dir, &a.path]);
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)?;
        match &a.from {
            AttachmentSource::Path(p) => {
                let mut input = std::fs::File::open(Path::new(p))?;
                std::io::copy(&mut input, &mut out)?;
            }
            AttachmentSource::Pasted { bytes, .. } => std::io::Write::write_all(&mut out, bytes)?,
        }
    }
    Ok(())
}
