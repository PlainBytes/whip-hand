//! `engine/diff.ts`: the working tree's change set, file by file, for the
//! desktop's diff review screen. Unlike `manual.rs`'s `working_diff`, it
//! includes untracked files and is not truncated at 400 lines.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::js::is_js_whitespace;
use crate::process::git::{GitResult, classify_git_failure};
use crate::process::launch::{ExecCode, ExecError, ExecOptions, exec_runner};

/// git's hash of the empty tree: the base for a repo with no commits yet.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// How many files we will put in front of a human at once.
pub const MAX_DIFF_FILES: usize = 500;

/// Per-file patch cap, in UTF-16 code units as TS's `chunk.length` counts.
pub const MAX_PATCH_BYTES: usize = 256 * 1024;

/// Across all files. Past this, later entries keep their counts and lose their patch.
pub const MAX_TOTAL_PATCH_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// One file of the diff, keys in the order TS writes them.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: DiffStatus,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiff {
    pub files: Vec<DiffFileEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files_truncated: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patches_omitted: Option<usize>,
}

/// One `--numstat -z` record, before its patch is attached.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NumstatEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
}

/// `Number.parseInt(s, 10) || 0` for a count: leading whitespace, an
/// optional sign, then digits. Anything else (or a negative) is 0.
fn parse_count(s: &str) -> u64 {
    let s = s.trim_start_matches(is_js_whitespace);
    let (negative, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let end = digits
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(digits.len());
    if negative {
        return 0;
    }
    digits[..end]
        .parse()
        .unwrap_or(if end == 0 { 0 } else { u64::MAX })
}

/// `--numstat -z` records: `adds\tdels\tpath\0`, or for a rename
/// `adds\tdels\t\0old\0new\0`. A path may hold a tab, so the counts are cut
/// off at the first two tabs rather than splitting on every one.
pub fn parse_numstat_z(stdout: &str) -> Vec<NumstatEntry> {
    let fields: Vec<&str> = stdout.split('\0').collect();
    let mut entries = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        let field = fields[i];
        if field.trim_matches(is_js_whitespace).is_empty() {
            i += 1;
            continue;
        }
        let Some(first_tab) = field.find('\t') else {
            i += 1;
            continue;
        };
        let Some(second_tab) = field[first_tab + 1..].find('\t').map(|n| n + first_tab + 1) else {
            i += 1;
            continue;
        };
        let raw_add = &field[..first_tab];
        let raw_del = &field[first_tab + 1..second_tab];
        let rest = &field[second_tab + 1..];
        let binary = raw_add == "-" && raw_del == "-";
        let (additions, deletions) = if binary {
            (0, 0)
        } else {
            (parse_count(raw_add), parse_count(raw_del))
        };
        if rest.is_empty() {
            let (Some(old), Some(new)) = (fields.get(i + 1), fields.get(i + 2)) else {
                break;
            };
            entries.push(NumstatEntry {
                path: (*new).to_string(),
                old_path: Some((*old).to_string()),
                additions,
                deletions,
                binary,
            });
            i += 3;
        } else {
            entries.push(NumstatEntry {
                path: rest.to_string(),
                old_path: None,
                additions,
                deletions,
                binary,
            });
            i += 1;
        }
    }
    entries
}

/// Byte offsets where a line starts under a JS `/m` regex: 0, and after
/// every `\n`, `\r`, U+2028 and U+2029.
fn js_line_starts(text: &str) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(
        text.char_indices()
            .filter(|&(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .map(|(i, c)| i + c.len_utf8()),
    )
}

/// `/^<prefix>/m.test(text)`.
fn has_line_starting(text: &str, prefix: &str) -> bool {
    js_line_starts(text).any(|i| text[i..].starts_with(prefix))
}

/// `/^<line>$/m.test(text)`: a whole line equal to `line`.
fn has_line(text: &str, line: &str) -> bool {
    js_line_starts(text).any(|i| {
        text[i..].strip_prefix(line).is_some_and(|after| {
            after.is_empty() || after.starts_with(['\n', '\r', '\u{2028}', '\u{2029}'])
        })
    })
}

/// One `git diff` patch into one chunk per file, in git's order. The header
/// stays with the chunk it introduces, and a `diff --git` inside a hunk body
/// cannot split it, because hunk lines are always prefixed.
pub fn split_patch(patch: &str) -> Vec<String> {
    const HEADER: &str = "diff --git ";
    if patch.trim_matches(is_js_whitespace).is_empty() {
        return Vec::new();
    }
    let starts: Vec<usize> = js_line_starts(patch)
        .filter(|&i| patch[i..].starts_with(HEADER))
        .collect();
    starts
        .iter()
        .enumerate()
        .map(|(n, &s)| patch[s..starts.get(n + 1).copied().unwrap_or(patch.len())].to_string())
        .collect()
}

fn is_binary_chunk(chunk: &str) -> bool {
    has_line_starting(chunk, "Binary files ") || has_line(chunk, "GIT binary patch")
}

fn status_of(chunk: Option<&str>, entry: &NumstatEntry) -> DiffStatus {
    if entry.old_path.is_some() {
        return DiffStatus::Renamed;
    }
    match chunk {
        Some(c) if has_line_starting(c, "new file mode ") => DiffStatus::Added,
        Some(c) if has_line_starting(c, "deleted file mode ") => DiffStatus::Deleted,
        _ => DiffStatus::Modified,
    }
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Attaches each chunk to its numstat entry by position. If the two lists
/// differ in length no pairing is made at all: showing a human the wrong
/// file's diff on a sign-off screen is worse than showing counts only.
pub fn pair_patches(entries: &[NumstatEntry], chunks: &[String]) -> WorkingDiff {
    let aligned = entries.len() == chunks.len();
    let mut omitted = 0;
    let mut total = 0;
    let files = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let chunk = if aligned {
                chunks.get(index).map(String::as_str)
            } else {
                None
            };
            let binary = entry.binary || chunk.is_some_and(is_binary_chunk);
            let mut file = DiffFileEntry {
                path: entry.path.clone(),
                old_path: entry.old_path.clone(),
                status: status_of(chunk, entry),
                additions: entry.additions,
                deletions: entry.deletions,
                binary,
                patch: None,
                truncated: None,
            };
            let Some(chunk) = chunk else {
                // A loss only when there was a patch pass to lose.
                if !aligned {
                    omitted += 1;
                }
                return file;
            };
            if binary {
                return file;
            }
            let len = js_len(chunk);
            if len > MAX_PATCH_BYTES || total + len > MAX_TOTAL_PATCH_BYTES {
                omitted += 1;
                file.truncated = Some(true);
                return file;
            }
            total += len;
            file.patch = Some(chunk.to_string());
            file
        })
        .collect();
    WorkingDiff {
        files,
        files_truncated: None,
        patches_omitted: (omitted > 0).then_some(omitted),
    }
}

/// `git diff` exits 1 to mean "there were differences", so exit 1 with
/// stdout is success.
async fn git_stdout(
    args: &[&str],
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<String, ExecError> {
    let argv: Vec<String> = std::iter::once("git")
        .chain(args.iter().copied())
        .map(str::to_string)
        .collect();
    let opts = ExecOptions {
        cwd: Some(cwd.to_path_buf()),
        env: env.clone(),
        max_buffer: Some(64 * 1024 * 1024),
        ..ExecOptions::default()
    };
    match exec_runner(&argv, opts).await {
        Ok((stdout, _)) => Ok(stdout),
        Err(e) if e.code == ExecCode::Exit(1) => Ok(e.stdout),
        Err(e) => Err(e),
    }
}

/// A temp directory for the throwaway index, removed when dropped.
struct IndexDir(PathBuf);

impl Drop for IndexDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The working tree against HEAD, file by file. `Ok(None)` means not a git
/// repository, and only that; git failing where it was expected to work is
/// an `Err`. Everything after the repo check degrades to counts without
/// patches rather than an empty screen.
///
/// The working tree is staged into a throwaway index (`GIT_INDEX_FILE`),
/// seeded from HEAD so deletes and renames register, and that is diffed
/// against HEAD. The real index is never touched.
pub async fn working_diff_files(
    workdir: &Path,
    max_files: usize,
) -> Result<Option<WorkingDiff>, String> {
    let none = BTreeMap::new();
    let head = match git_stdout(
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        workdir,
        &none,
    )
    .await
    {
        Ok(out) => out,
        Err(e) => {
            return match classify_git_failure::<()>(&e.code, &e.stderr, &e.message) {
                GitResult::NotARepo => Ok(None),
                GitResult::Unavailable(reason) => Err(reason),
                GitResult::Ok(()) => unreachable!("a failure never classifies as ok"),
            };
        }
    };
    let base = if head.trim_matches(is_js_whitespace).is_empty() {
        EMPTY_TREE
    } else {
        "HEAD"
    };

    let dir = std::env::temp_dir().join(format!("whiphand-diff-{}", crate::random::hex(6)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dir = IndexDir(dir);
    let mut env = BTreeMap::new();
    env.insert(
        "GIT_INDEX_FILE".to_string(),
        dir.0.join("index").to_string_lossy().into_owned(),
    );

    let fail = |e: ExecError| e.message;
    git_stdout(&["read-tree", base], workdir, &env)
        .await
        .map_err(fail)?;
    // `[.]` rather than `.`: git refuses an exclude whose literal prefix is
    // gitignored, and a user may ignore .whiphand/.
    git_stdout(
        &["add", "-A", "--", ".", ":(exclude,glob)[.]whiphand/**"],
        workdir,
        &env,
    )
    .await
    .map_err(fail)?;

    // Every flag defends against a user's gitconfig; both passes must carry
    // the same ones or the two lists can come back different lengths.
    let shared = [
        "-c",
        "core.quotepath=false",
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "--no-pager",
        "diff",
        "--cached",
        base,
        "--find-renames",
        "--no-ext-diff",
        "--no-color",
    ];
    let pathspec = ["--", ".", ":(exclude,glob)[.]whiphand/**"];

    let numstat_args: Vec<&str> = shared
        .iter()
        .copied()
        .chain(["--numstat", "-z"])
        .chain(pathspec)
        .collect();
    let numstat = git_stdout(&numstat_args, workdir, &env)
        .await
        .map_err(fail)?;
    let mut entries = parse_numstat_z(&numstat);
    let files_truncated = entries.len().saturating_sub(max_files);
    entries.truncate(max_files);

    if entries.is_empty() {
        return Ok(Some(WorkingDiff::default()));
    }

    // The patch pass can be enormous; its failure (a maxBuffer overflow)
    // degrades to counts without patches.
    let patch_args: Vec<&str> = shared
        .iter()
        .copied()
        .chain(["--unified=3"])
        .chain(pathspec)
        .collect();
    let mut chunks = match git_stdout(&patch_args, workdir, &env).await {
        Ok(patch) => split_patch(&patch),
        Err(_) => Vec::new(),
    };
    // The entry list may have been capped; trim to match or the pairing
    // guard fires on our own cap.
    chunks.truncate(entries.len());

    let mut result = if chunks.is_empty() {
        WorkingDiff {
            files: pair_patches(&entries, &[]).files,
            files_truncated: None,
            patches_omitted: Some(entries.len()),
        }
    } else {
        pair_patches(&entries, &chunks)
    };
    if files_truncated > 0 {
        result.files_truncated = Some(files_truncated);
    }
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_reads_renames_binaries_and_tabbed_paths() {
        let entries = parse_numstat_z(
            "-\t-\tb.png\0\
             1\t1\t\0old.txt\0new.txt\0\
             4\t0\tweird\tname\0\n",
        );
        let paths: Vec<_> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["b.png", "new.txt", "weird\tname"]);
        assert!(entries[0].binary);
        assert_eq!(entries[1].old_path.as_deref(), Some("old.txt"));
    }

    #[test]
    fn split_patch_splits_on_js_line_starts() {
        let chunks = split_patch("diff --git a/x b/x\n+a\rdiff --git a/y b/y\n");
        assert_eq!(chunks, ["diff --git a/x b/x\n+a\r", "diff --git a/y b/y\n"]);
    }

    #[test]
    fn misaligned_lists_attach_no_patch() {
        let entries = parse_numstat_z("1\t0\ta\0\x31\t0\tb\0");
        let result = pair_patches(&entries, &["diff --git a/a b/a\n".to_string()]);
        assert!(result.files.iter().all(|f| f.patch.is_none()));
        assert_eq!(result.patches_omitted, Some(2));
    }
}
