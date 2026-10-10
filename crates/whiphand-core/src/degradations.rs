//! `degradations.ts`: the closed set of things whiphand can lose without
//! stopping (invariant 7), and how one renders.

/// Every degradation id with its label, in declaration order.
pub const DEGRADATIONS: &[(&str, &str)] = &[
    (
        "git-guard",
        "Read-only tree guard off (not a git repository)",
    ),
    ("diff", "Step diff unavailable"),
    ("await-state", "Await-state unavailable for this runner"),
    ("hooks", "Runner hooks dropped"),
    ("retention", "Old run directories could not be pruned"),
    ("workspace-identity", "Workspace identity not canonicalized"),
    ("process-containment", "Process containment unavailable"),
    ("stopped-tree", "Stopped-tree snapshot unavailable"),
    ("posix-shell", "No POSIX shell found"),
    ("git-wrapper", "git is a .cmd wrapper"),
    (
        "git-ownership",
        "git refuses this repository (dubious ownership)",
    ),
    (
        "token-file-mode",
        "Remote token file mode is not enforceable",
    ),
    (
        "long-path",
        "Workspace path leaves little headroom under 260 characters",
    ),
    (
        "worktree-sync",
        "Worktree started from the local base, not its upstream",
    ),
];

pub fn is_degradation_id(value: &str) -> bool {
    DEGRADATIONS.iter().any(|(id, _)| *id == value)
}

/// One rendered line: `<label> — <reason>`, with the step when it is step-scoped.
pub fn degradation_line(capability: &str, reason: &str, step_id: Option<&str>) -> String {
    let label = DEGRADATIONS
        .iter()
        .find(|(id, _)| *id == capability)
        .map_or(capability, |(_, label)| label);
    let step = step_id.map(|s| format!(" [{s}]")).unwrap_or_default();
    format!("{label}{step} — {reason}")
}
