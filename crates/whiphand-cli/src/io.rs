//! Writing to stdout and stderr the way `console.log`/`console.error` do,
//! except that a closed pipe (`whiphand run | head`) is not a crash.

use std::io::Write;

pub fn out_raw(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

pub fn err_raw(text: &str) {
    let mut err = std::io::stderr().lock();
    let _ = err.write_all(text.as_bytes());
    let _ = err.flush();
}

pub fn out_bytes(bytes: &[u8]) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(bytes);
    let _ = out.flush();
}

pub fn err_bytes(bytes: &[u8]) {
    let mut err = std::io::stderr().lock();
    let _ = err.write_all(bytes);
    let _ = err.flush();
}

/// `console.log(line)`.
pub fn out_line(line: &str) {
    out_raw(&format!("{line}\n"));
}

/// `console.error(line)`.
pub fn err_line(line: &str) {
    err_raw(&format!("{line}\n"));
}
