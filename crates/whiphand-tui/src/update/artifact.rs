//! An artifact viewer's part of `update`, for any screen that shows one:
//! reading a file into an `ArtifactView`, handing it to `$EDITOR` and saving
//! the result. The owning screen finds its view; these work on the view and
//! say which calls to make.

use serde_json::Value;
use whiphand_protocol as p;

use crate::client::{self, Call, ReadArtifact, StatArtifact, WriteArtifact};
use crate::cmd::{Cmd, External, Then};
use crate::model::detail::{ArtifactBody, ArtifactView};
use crate::model::{ArtifactOwner, EditTarget};

/// Artifacts bigger than this are left to the pager.
const MAX_ARTIFACT_BYTES: u64 = 1024 * 1024;

fn artifact_ref(workdir: &str, run_id: &str, name: &str) -> p::ArtifactRefParams {
    p::ArtifactRefParams {
        workdir: workdir.to_string(),
        run_id: run_id.to_string(),
        name: name.to_string(),
    }
}

fn stat(owner: ArtifactOwner, workdir: &str, run_id: &str, name: &str) -> Cmd {
    Cmd::Rpc(Call::new::<StatArtifact>(
        artifact_ref(workdir, run_id, name),
        Then::ArtifactStat {
            owner,
            run_id: run_id.to_string(),
            name: name.to_string(),
        },
    ))
}

/// A view of `name` that is loading, and the call that starts it.
pub fn open(
    owner: ArtifactOwner,
    workdir: &str,
    run_id: &str,
    name: String,
    path: String,
) -> (ArtifactView, Cmd) {
    let cmd = stat(owner, workdir, run_id, &name);
    let view = ArtifactView {
        name,
        path,
        body: ArtifactBody::Loading,
        scroll: 0,
        mtime_ms: None,
    };
    (view, cmd)
}

/// `statArtifact` answered: too large to read, or the read to make next.
pub fn on_stat(
    view: &mut ArtifactView,
    owner: ArtifactOwner,
    workdir: &str,
    run_id: &str,
    value: Value,
) -> Option<Cmd> {
    match client::decode::<StatArtifact>(value) {
        Ok(stat) if stat.size > MAX_ARTIFACT_BYTES => view.body = ArtifactBody::TooLarge(stat.size),
        Ok(_) => {
            let params = artifact_ref(workdir, run_id, &view.name);
            return Some(Cmd::Rpc(Call::new::<ReadArtifact>(
                p::ReadArtifactParams {
                    workdir: params.workdir,
                    run_id: params.run_id,
                    name: params.name,
                    encoding: Some(p::ArtifactEncoding::Utf8),
                },
                Then::Artifact {
                    owner,
                    run_id: run_id.to_string(),
                    name: view.name.clone(),
                },
            )));
        }
        Err(e) => view.body = ArtifactBody::Failed(e),
    }
    None
}

/// `readArtifact` answered.
pub fn on_read(view: &mut ArtifactView, value: Value) {
    view.body = match client::decode::<ReadArtifact>(value) {
        Ok(a) if a.content.contains('\0') => ArtifactBody::Binary(a.size),
        Ok(a) => {
            view.mtime_ms = Some(a.mtime_ms);
            ArtifactBody::Text(a.content)
        }
        Err(e) => ArtifactBody::Failed(e),
    };
}

/// A stat or read failed.
pub fn on_error(view: &mut ArtifactView, message: &str) {
    view.body = ArtifactBody::Failed(message.to_string());
}

/// The view back to loading, and the call that reads the file as it is now.
/// `view` is `None` when the owner no longer shows the artifact.
pub fn reread(
    view: Option<&mut ArtifactView>,
    owner: ArtifactOwner,
    workdir: &str,
    run_id: &str,
    name: &str,
) -> Cmd {
    if let Some(view) = view {
        view.body = ArtifactBody::Loading;
        view.mtime_ms = None;
        view.scroll = 0;
    }
    stat(owner, workdir, run_id, name)
}

/// The artifact in `$EDITOR`: `draft` (an edit refused earlier) when there
/// is one, else the text on screen. Why not, when it is not editable text.
pub fn edit(
    view: &ArtifactView,
    owner: ArtifactOwner,
    workdir: &str,
    run_id: &str,
    draft: Option<String>,
) -> Result<(EditTarget, Cmd), String> {
    let (ArtifactBody::Text(text), Some(mtime_ms)) = (&view.body, view.mtime_ms) else {
        return Err(format!("{} is not text the TUI can edit", view.name));
    };
    let target = EditTarget::Artifact {
        owner,
        workdir: workdir.to_string(),
        run_id: run_id.to_string(),
        name: view.name.clone(),
        text: text.clone(),
        mtime_ms,
    };
    let suffix = if view.name.ends_with(".md") {
        ".md"
    } else {
        ".txt"
    };
    let cmd = Cmd::Suspend(External::Editor {
        text: draft.unwrap_or_else(|| text.clone()),
        suffix,
    });
    Ok((target, cmd))
}

/// What `$EDITOR` left behind.
pub enum Edited {
    /// The same text that was read; nothing to save.
    Unchanged,
    /// A new text: kept as the draft until the write lands, with the write.
    Save { draft: String, cmd: Cmd },
}

/// `$EDITOR` returned `edited` for `target`: saved when it changed, as long
/// as the file is still what was read. `None` when `target` is no artifact.
pub fn on_edited(target: EditTarget, edited: String) -> Option<Edited> {
    let EditTarget::Artifact {
        owner,
        workdir,
        run_id,
        name,
        text,
        mtime_ms,
    } = target
    else {
        return None;
    };
    if edited == text {
        return Some(Edited::Unchanged);
    }
    let cmd = Cmd::Rpc(Call::new::<WriteArtifact>(
        p::WriteArtifactParams {
            workdir,
            run_id: run_id.clone(),
            name: name.clone(),
            content: edited.clone(),
            expected_mtime_ms: Some(mtime_ms),
        },
        Then::ArtifactWritten {
            owner,
            run_id,
            name,
        },
    ));
    Some(Edited::Save { draft: edited, cmd })
}

/// `writeArtifact` answered: why it was refused, if it was.
pub fn on_written(value: Value) -> Result<(), String> {
    client::decode::<WriteArtifact>(value).map(|_| ())
}
