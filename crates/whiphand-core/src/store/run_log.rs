//! Reading `run.log` back (`engine/run-log.ts`'s `readRunLog`), for a finished
//! or reopened run's Logs tab. The journal writes the file; this pages it.
//!
//! Three modes share one result shape:
//! - `from_end`: the last `limit` lines, through a bounded tail read.
//! - `before_byte`: page backwards from a byte offset a previous tail read
//!   reported, for a "load earlier" control.
//! - plain `offset`/`limit`: forward paging over the whole file.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::store::markers::RUN_LOG_NAME;

/// Initial guess at how many bytes hold `limit` lines, doubled when it undershoots.
const TAIL_BYTES_PER_LINE_GUESS: u64 = 512;

#[derive(Clone, Debug, Default)]
pub struct ReadRunLogParams {
    /// Forward paging from the start; ignored when `from_end` or `before_byte` is set.
    pub offset: Option<usize>,
    pub limit: usize,
    pub from_end: bool,
    pub before_byte: Option<u64>,
}

/// `total`/`truncated` are set only in offset mode, `start_byte`/`at_start`
/// only in the tail modes, as in TS.
#[derive(Clone, Debug, PartialEq)]
pub struct ReadRunLogResult {
    pub lines: Vec<String>,
    pub total: Option<usize>,
    pub truncated: Option<bool>,
    pub start_byte: Option<u64>,
    pub at_start: Option<bool>,
}

impl ReadRunLogResult {
    fn tail(lines: Vec<String>, start_byte: u64) -> Self {
        Self {
            lines,
            total: None,
            truncated: None,
            start_byte: Some(start_byte),
            at_start: Some(start_byte == 0),
        }
    }
}

/// Reads `len` bytes at `start` into a zeroed buffer. A short read leaves the
/// rest zeroed, as `FileHandle.read` into `Buffer.alloc` does when
/// `before_byte` lies past the end of the file.
fn read_at(file: &mut File, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    let mut buf = vec![0u8; len as usize];
    file.seek(SeekFrom::Start(start))?;
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(buf)
}

/// The last `limit` complete lines ending at `end_byte`, through an expanding
/// window. Splitting on the raw `\n` byte is safe for UTF-8, because 0x0A
/// never appears inside a multi-byte sequence.
fn tail_lines(file: &mut File, end_byte: u64, limit: usize) -> std::io::Result<ReadRunLogResult> {
    let mut window = (limit as u64 * TAIL_BYTES_PER_LINE_GUESS).max(TAIL_BYTES_PER_LINE_GUESS);
    loop {
        let start = end_byte.saturating_sub(window);
        let buf = read_at(file, start, end_byte - start)?;

        // The window rarely starts on a line boundary; drop the partial line
        // it lands in. At the true start of the file there is none.
        let line_start_byte = if start > 0 {
            buf.iter()
                .position(|&b| b == b'\n')
                .map_or(buf.len(), |i| i + 1)
        } else {
            0
        };
        let usable = &buf[line_start_byte..];

        let mut ranges = Vec::new();
        let mut line_start = 0;
        for (i, &b) in usable.iter().enumerate() {
            if b == b'\n' {
                ranges.push((line_start, i));
                line_start = i + 1;
            }
        }
        // An unterminated run only occurs at true EOF; keep it.
        if line_start < usable.len() {
            ranges.push((line_start, usable.len()));
        }

        if ranges.len() >= limit || start == 0 {
            // `ranges.slice(-limit)`: a limit of 0 is `slice(-0)`, every range.
            let kept = if limit == 0 {
                &ranges[..]
            } else {
                &ranges[ranges.len().saturating_sub(limit)..]
            };
            let Some(&(first, _)) = kept.first() else {
                return Ok(ReadRunLogResult::tail(
                    Vec::new(),
                    start + line_start_byte as u64,
                ));
            };
            let start_byte = start + (line_start_byte + first) as u64;
            let lines = kept
                .iter()
                .map(|&(s, e)| String::from_utf8_lossy(&usable[s..e]).into_owned())
                .collect();
            return Ok(ReadRunLogResult::tail(lines, start_byte));
        }
        window *= 2;
    }
}

/// A paged read of `<run_dir>/run.log`. A missing or unreadable file is an
/// empty page, never an error.
pub fn read_run_log(run_dir: &Path, params: &ReadRunLogParams) -> ReadRunLogResult {
    let file = run_dir.join(RUN_LOG_NAME);
    if params.from_end || params.before_byte.is_some() {
        let empty = ReadRunLogResult::tail(Vec::new(), 0);
        let Ok(mut handle) = File::open(&file) else {
            return empty;
        };
        let end_byte = match params.before_byte {
            Some(b) => b,
            None => match handle.metadata() {
                Ok(m) => m.len(),
                Err(_) => return empty,
            },
        };
        if end_byte == 0 {
            return empty;
        }
        return tail_lines(&mut handle, end_byte, params.limit).unwrap_or(empty);
    }

    let Ok(bytes) = std::fs::read(&file) else {
        return ReadRunLogResult {
            lines: Vec::new(),
            total: Some(0),
            truncated: Some(false),
            start_byte: None,
            at_start: None,
        };
    };
    let raw = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = raw.split('\n').filter(|l| !l.is_empty()).collect();
    let total = all.len();
    let offset = params.offset.unwrap_or(0).min(total);
    let end = offset.saturating_add(params.limit).min(total);
    let lines: Vec<String> = all[offset..end].iter().map(|l| (*l).to_string()).collect();
    let truncated = offset + lines.len() < total;
    ReadRunLogResult {
        lines,
        total: Some(total),
        truncated: Some(truncated),
        start_byte: None,
        at_start: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_dir(content: Option<&[u8]>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        if let Some(c) = content {
            std::fs::write(dir.path().join(RUN_LOG_NAME), c).unwrap();
        }
        dir
    }

    fn lines(n: usize) -> Vec<u8> {
        (1..=n)
            .map(|i| format!("line {i}\n"))
            .collect::<String>()
            .into_bytes()
    }

    #[test]
    fn tail_reads_expand_past_the_first_window() {
        let dir = run_dir(Some(&lines(500)));
        let params = ReadRunLogParams {
            limit: 10,
            from_end: true,
            ..Default::default()
        };
        let r = read_run_log(dir.path(), &params);
        assert_eq!(r.lines.first().unwrap(), "line 491");
        assert_eq!(r.lines.last().unwrap(), "line 500");
        assert_eq!(r.at_start, Some(false));
        assert_eq!(r.total, None);

        let earlier = ReadRunLogParams {
            limit: 10,
            before_byte: r.start_byte,
            ..Default::default()
        };
        let r2 = read_run_log(dir.path(), &earlier);
        assert_eq!(r2.lines.first().unwrap(), "line 481");
        assert_eq!(r2.lines.last().unwrap(), "line 490");
    }

    #[test]
    fn a_missing_file_is_an_empty_page_in_both_modes() {
        let dir = run_dir(None);
        let tail = read_run_log(
            dir.path(),
            &ReadRunLogParams {
                limit: 5,
                from_end: true,
                ..Default::default()
            },
        );
        assert_eq!(tail, ReadRunLogResult::tail(Vec::new(), 0));
        let fwd = read_run_log(
            dir.path(),
            &ReadRunLogParams {
                limit: 5,
                ..Default::default()
            },
        );
        assert_eq!((fwd.total, fwd.truncated), (Some(0), Some(false)));
    }

    #[test]
    fn offset_mode_pages_and_reports_truncation() {
        let dir = run_dir(Some(&lines(10)));
        let r = read_run_log(
            dir.path(),
            &ReadRunLogParams {
                offset: Some(8),
                limit: 4,
                ..Default::default()
            },
        );
        assert_eq!(r.lines, ["line 9", "line 10"]);
        assert_eq!((r.total, r.truncated), (Some(10), Some(false)));
    }
}
