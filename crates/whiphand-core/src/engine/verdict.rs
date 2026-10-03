//! `engine/verdict.ts`: what a `verdict: true` step is told, and how a
//! verdict is read off an artifact, an exit code or a human's answer.

use std::sync::LazyLock;

use regex::Regex;

/// What a `verdict: true` step's prompt ends with.
pub const VERDICT_INSTRUCTION: &str = "The very first line of the artifact MUST be exactly 'VERDICT: PASS' or 'VERDICT: FAIL'.\n\n\
PASS means nothing blocking remains: every requirement of the attached plan or stage is met, and nothing was changed that should not have been.\n\n\
FAIL means at least one blocking finding. Each blocking finding must be concrete: the file, what is wrong, and what would fix it.\n\n\
After the verdict line, use these sections, in this order:\n\n\
## Blocking\nThe findings that make this a FAIL. Empty on a PASS.\n\n\
## Non-blocking\nEverything worth saying that does not block, including nitpicks outside the step's scope.\n\n\
## Needs a human\nWhat could not be verified headless, such as a manual repro or a visual check. Items here never turn a PASS into a FAIL by themselves, but list them here rather than burying them in prose.";

/// `/^VERDICT:\s*(PASS|FAIL)\b/i`: ASCII case-folding and an ASCII word
/// boundary, as JS has them without the `u` flag.
static VERDICT_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^[Vv][Ee][Rr][Dd][Ii][Cc][Tt]:[{}]*([Pp][Aa][Ss][Ss]|[Ff][Aa][Ii][Ll])(?-u:\b)",
        crate::js::JS_WS_CLASS
    ))
    .unwrap()
});

/// The verdict on an artifact's first line, if it has one.
pub fn parse_verdict(text: &str) -> Option<&'static str> {
    let first = text.split('\n').next().unwrap_or("");
    let caps = VERDICT_LINE.captures(first)?;
    Some(if caps[1].eq_ignore_ascii_case("pass") {
        "pass"
    } else {
        "fail"
    })
}

/// A command step's verdict: its exit code against `expect_exit` (default `[0]`).
pub fn verdict_from_exit(code: i32, expect: Option<&[i64]>) -> &'static str {
    let expect = expect.unwrap_or(&[0]);
    if expect.contains(&i64::from(code)) {
        "pass"
    } else {
        "fail"
    }
}

/// A manual step's verdict: `continue` passes, `retry` fails.
pub fn verdict_from_choice(choice: &str) -> &'static str {
    if choice == "continue" { "pass" } else { "fail" }
}
