//! `engine/stages.ts`: which stage files a `stages` step iterates, in what
//! order, and which runs next.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::glob::glob_fs;
use crate::node_path;
use crate::segment::validate_segment;
use crate::template::Stage;

/// Extra attempts a failing stage gets when its step sets no `max_retries`.
pub const DEFAULT_STAGE_RETRIES: u64 = 2;

static CONVENTIONAL_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+[a-z]*-").unwrap());
/// `/^#\s+(.+?)\s*$/m`, with JS's `\s` and `.` (which also stops at `\r`,
/// U+2028 and U+2029). `\s+` may run onto the next line, as in JS.
static HEADING: LazyLock<Regex> = LazyLock::new(|| {
    let ws = crate::js::JS_WS_CLASS;
    Regex::new(&format!(
        r"(?mR)^#[{ws}]+([^\n\r\x{{2028}}\x{{2029}}]+?)[{ws}]*$"
    ))
    .unwrap()
});

/// The first `# heading`, else the id.
pub fn stage_title_of(text: &str, fallback: &str) -> String {
    HEADING
        .captures(text)
        .map_or_else(|| fallback.to_string(), |c| c[1].to_string())
}

/// The stage files `pattern` matches under `workdir`, ordered by path
/// compared with plain `<`, each with its index, total, id and title.
pub fn discover_stages(workdir: &str, pattern: &str) -> Result<Vec<Stage>, String> {
    let mut rel: Vec<String> = glob_fs(pattern, workdir)
        .into_iter()
        .map(|p| p.replace('\\', "/"))
        .collect();
    rel.sort_by(|a, b| crate::js::utf16_cmp(a, b));
    let mut found = Vec::new();
    for rel_path in &rel {
        let path = if node_path::is_absolute(rel_path) {
            node_path::resolve(rel_path)
        } else {
            node_path::resolve(&node_path::join(&[workdir, rel_path]))
        };
        let file = path.rsplit(['/', '\\']).next().unwrap_or(&path).to_string();
        let id = match file.rfind('.') {
            Some(i) if i > 0 || file.len() > 1 => {
                // `/\.[^.]+$/`: the last extension, when it has at least one char.
                if i + 1 < file.len() {
                    file[..i].to_string()
                } else {
                    file.clone()
                }
            }
            _ => file.clone(),
        };
        if id.contains(['@', '#', '/', '\\']) {
            return Err(format!(
                "stage file '{file}': a stage name cannot contain '@', '#', '/' or '\\'"
            ));
        }
        if let Err(reason) = validate_segment(&id) {
            return Err(format!("stage file '{file}': its id '{id}' {reason}"));
        }
        let text = match std::fs::read(&path) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(e) => {
                let why = if std::fs::metadata(&path).is_ok_and(|m| m.is_dir()) {
                    "is a directory, not a stage file".to_string()
                } else if e.kind() == std::io::ErrorKind::NotFound {
                    "disappeared before it could be read".to_string()
                } else {
                    format!(
                        "could not be read ({})",
                        crate::process::launch::errno_name_of(&e)
                    )
                };
                return Err(format!("stage file '{rel_path}' {why}"));
            }
        };
        let title = stage_title_of(&text, &id);
        found.push((id, title, path));
    }
    let total = found.len() as u64;
    Ok(found
        .into_iter()
        .enumerate()
        .map(|(i, (id, title, path))| Stage {
            index: i as u64 + 1,
            total,
            id,
            title,
            path,
        })
        .collect())
}

/// The first stage, in order, not yet completed.
pub fn next_stage<'a>(stages: &'a [Stage], completed: &HashSet<String>) -> Option<&'a Stage> {
    stages.iter().find(|s| !completed.contains(&s.id))
}

/// Ids that do not read as `NN-slug`.
pub fn odd_stage_names(stages: &[Stage]) -> Vec<String> {
    stages
        .iter()
        .filter(|s| !CONVENTIONAL_ID.is_match(&s.id))
        .map(|s| s.id.clone())
        .collect()
}
