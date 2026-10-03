//! The commands end to end, through the built binary (what
//! `packages/cli/src/commands/*.test.ts` and `run-json.test.ts` covered). The
//! cross-implementation half lives in `parity/behavior.test.ts`.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use tempfile::TempDir;

struct Env {
    home: TempDir,
    ws: TempDir,
}

impl Env {
    fn new() -> Self {
        Env {
            home: tempfile::tempdir().unwrap(),
            ws: tempfile::tempdir().unwrap(),
        }
    }

    fn ws(&self) -> &Path {
        self.ws.path()
    }

    fn command(&self, args: &[&str], cwd: &Path) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_whiphand"));
        cmd.args(args)
            .current_dir(cwd)
            .env("WHIPHAND_CONFIG_HOME", self.home.path())
            .stdin(Stdio::null());
        cmd
    }

    /// `whiphand <args> -C <workspace>`, from the workspace.
    fn run(&self, args: &[&str]) -> Out {
        let ws = self.ws().to_string_lossy().into_owned();
        let mut all: Vec<&str> = args.to_vec();
        all.extend(["-C", &ws]);
        Out(self.command(&all, self.ws()).output().unwrap())
    }

    fn write(&self, rel: &str, text: &str) -> PathBuf {
        let path = self.ws().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    fn project_config(&self) -> Option<String> {
        std::fs::read_to_string(self.ws().join(".whiphand/config.yaml")).ok()
    }

    fn runs_dir(&self) -> PathBuf {
        self.ws().join(".whiphand/runs")
    }

    fn only_run(&self) -> PathBuf {
        let mut runs: Vec<PathBuf> = std::fs::read_dir(self.runs_dir())
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        assert_eq!(runs.len(), 1, "{runs:?}");
        runs.pop().unwrap()
    }
}

struct Out(Output);

impl Out {
    fn code(&self) -> i32 {
        self.0.status.code().unwrap_or(-1)
    }
    fn stdout(&self) -> String {
        String::from_utf8_lossy(&self.0.stdout).into_owned()
    }
    fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.0.stderr).into_owned()
    }
}

const RUN_ID: &str = "20260101-000000-aaaa";

// ------------------------------------------------------------------ run: usage

#[test]
fn resume_refuses_a_workflow_argument() {
    let e = Env::new();
    let out = e.run(&["run", "cycle", "--resume", RUN_ID]);
    assert_eq!(out.code(), 2);
    assert!(
        out.stderr().contains("do not also name one"),
        "{}",
        out.stderr()
    );
}

#[test]
fn resume_refuses_dry_run() {
    let e = Env::new();
    let out = e.run(&["run", "--resume", RUN_ID, "--dry-run"]);
    assert_eq!(out.code(), 2);
    assert!(out.stderr().contains("--dry-run"));
}

#[test]
fn a_plain_run_with_no_workflow_says_what_is_missing() {
    let e = Env::new();
    let out = e.run(&["run"]);
    assert_eq!(out.code(), 2);
    assert!(out.stderr().contains("--resume"));
}

#[test]
fn resume_reports_why_a_run_cannot_be_resumed() {
    let e = Env::new();
    let out = e.run(&["run", "--resume", RUN_ID]);
    assert_eq!(
        out.code(),
        1,
        "a refusal is a run failure, not a usage error"
    );
    assert!(out.stderr().contains("no run"), "{}", out.stderr());
}

#[test]
fn resume_with_attach_or_both_budgets_is_a_usage_error() {
    let e = Env::new();
    let out = e.run(&["run", "--resume", RUN_ID, "--attach", "x.png"]);
    assert_eq!(out.code(), 2);
    assert!(out.stderr().contains("--attach"));
    let out = e.run(&["run", "cycle", "--extra-iterations", "2"]);
    assert_eq!(out.code(), 2);
    assert!(out.stderr().contains("--extra-iterations") && out.stderr().contains("--resume"));
    let out = e.run(&[
        "run",
        "--resume",
        RUN_ID,
        "--extra-iterations",
        "2",
        "--max-iterations",
        "5",
    ]);
    assert_eq!(out.code(), 2);
    assert!(out.stderr().contains("--max-iterations"));
}

#[test]
fn run_prints_workflow_warnings_to_stderr() {
    let e = Env::new();
    e.write(
        ".whiphand/workflows/x.yaml",
        "name: x\nsteps:\n  - id: sign\n    kind: approval\n    title: \"Ship it?\"\n    instructions: \"Look at the diff.\"\n    show_diff: true\n    capture: review\n    output: feedback.md\n",
    );
    let out = e.run(&["run", "x", "--dry-run"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(
        out.stderr().contains("'review' outside a loop"),
        "{}",
        out.stderr()
    );
}

// ------------------------------------------------------------------ run: attachments

fn attach_workspace(e: &Env) {
    e.write(
        ".whiphand/workflows/triage.yaml",
        "name: triage\nsteps:\n  - id: look\n    kind: command\n    inputs: [attachments]\n    run: ls \"$WHIPHAND_RUN_DIR/attachments\"\n",
    );
    e.write(
        ".whiphand/workflows/plain.yaml",
        "name: plain\nsteps:\n  - id: look\n    kind: command\n    run: \"true\"\n",
    );
}

#[test]
fn attach_resolves_a_relative_path_against_the_shell_cwd_not_c() {
    let e = Env::new();
    attach_workspace(&e);
    let shell = tempfile::tempdir().unwrap();
    std::fs::write(shell.path().join("bug.png"), "PNG").unwrap();
    let ws = e.ws().to_string_lossy().into_owned();
    let out = Out(e
        .command(
            &[
                "run",
                "triage",
                "--dry-run",
                "--json",
                "--attach",
                "bug.png",
                "-C",
                &ws,
            ],
            shell.path(),
        )
        .output()
        .unwrap());
    assert_eq!(out.code(), 0, "{}", out.stderr());
    let manifest = std::fs::read_to_string(e.only_run().join("run.json")).unwrap();
    let source = shell.path().join("bug.png").to_string_lossy().into_owned();
    let expected = serde_json::json!([{
        "name": "bug.png", "path": "attachments/bug.png", "size": 3, "source": source,
    }]);
    let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(manifest["attachments"], expected);
    // A dry run records the list and copies nothing.
    assert!(!e.only_run().join("attachments").exists());
}

#[test]
fn a_missing_attachment_is_refused_before_any_run_exists() {
    let e = Env::new();
    attach_workspace(&e);
    let missing = e.ws().join("nope.png").to_string_lossy().into_owned();
    let out = e.run(&["run", "triage", "--dry-run", "--attach", &missing]);
    assert_eq!(out.code(), 2);
    assert_eq!(out.stderr(), format!("✘ attachment not found: {missing}\n"));
    assert!(!e.runs_dir().exists());
}

#[test]
fn attaching_to_a_workflow_that_reads_none_is_refused_with_the_fix() {
    let e = Env::new();
    attach_workspace(&e);
    let file = e.write("a.log", "x").to_string_lossy().into_owned();
    let out = e.run(&["run", "plain", "--dry-run", "--attach", &file]);
    assert_eq!(out.code(), 2);
    assert!(
        out.stderr()
            .starts_with("✘ 1 file attached, but no step reads `attachments`."),
        "{}",
        out.stderr()
    );
    assert!(out.stderr().contains("inputs: [attachments]"));
    assert!(!e.runs_dir().exists());
}

// ------------------------------------------------------------------ run: --yes and stages

fn staged_yaml(gate_default: &str) -> String {
    format!(
        "name: staged\nsteps:\n  - id: build\n    kind: stages\n    items: \"plans/*.md\"\n    steps:\n      - id: implement\n        kind: command\n        run: \"true\"\n        output: report.log\n      - id: accept\n        kind: approval\n        title: \"Ship it?\"\n        instructions: \"Look.\"\n{gate_default}\n"
    )
}

fn staged_workspace(e: &Env, gate_default: &str) {
    e.write("plans/01-a.md", "# A\n");
    e.write(
        ".whiphand/workflows/staged.yaml",
        &staged_yaml(gate_default),
    );
}

#[test]
fn yes_refuses_a_stage_gate_with_no_explicit_default() {
    let e = Env::new();
    staged_workspace(&e, "");
    let out = e.run(&["run", "staged", "--dry-run", "--yes"]);
    assert_eq!(out.code(), 2);
    assert!(
        out.stderr().contains(
            "step 'accept': a gate inside stages step 'build' must set an explicit 'default'"
        ),
        "{}",
        out.stderr()
    );
    assert!(
        out.stderr().contains("default: continue"),
        "the refusal names the fix"
    );
    assert!(!e.runs_dir().exists(), "refused before any step ran");
}

#[test]
fn yes_runs_a_stage_gate_that_opted_in() {
    let e = Env::new();
    staged_workspace(&e, "        default: continue");
    let out = e.run(&["run", "staged", "--dry-run", "--json", "--yes"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
}

#[test]
fn yes_still_answers_an_ordinary_gate() {
    let e = Env::new();
    e.write(
        ".whiphand/workflows/plain.yaml",
        "name: plain\nsteps:\n  - id: sign\n    kind: approval\n    title: \"Ship it?\"\n    instructions: \"Look.\"\n",
    );
    let out = e.run(&["run", "plain", "--dry-run", "--json", "--yes"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
}

#[test]
fn resume_yes_is_refused_like_a_fresh_run() {
    let e = Env::new();
    let run_dir = e.runs_dir().join(RUN_ID);
    std::fs::create_dir_all(&run_dir).unwrap();
    let manifest = serde_json::json!({
        "version": whiphand_core::store::journal::MANIFEST_VERSION, "runId": RUN_ID, "workflow": "staged",
        "workdir": e.ws(), "dryRun": false, "pid": 999_999, "startedAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z", "endedAt": "2026-01-01T00:00:00Z", "status": "failed",
        "ok": false, "inputs": {}, "sessionIds": {}, "steps": [],
    });
    std::fs::write(run_dir.join("run.json"), manifest.to_string()).unwrap();
    std::fs::write(run_dir.join("workflow.yaml"), staged_yaml("")).unwrap();
    let out = e.run(&["run", "--resume", RUN_ID, "--yes"]);
    assert_eq!(out.code(), 2, "{}", out.stderr());
    assert!(out.stderr().contains(
        "step 'accept': a gate inside stages step 'build' must set an explicit 'default'"
    ));
}

#[test]
fn a_gate_without_a_terminal_or_yes_fails_the_run() {
    let e = Env::new();
    e.write(
        ".whiphand/workflows/gate.yaml",
        "name: gate\nsteps:\n  - id: sign\n    kind: manual\n    title: Go?\n    instructions: Say.\n",
    );
    let out = e.run(&["run", "gate"]);
    assert_eq!(out.code(), 1);
    assert!(out.stderr().contains("needs a human"), "{}", out.stderr());
}

// ------------------------------------------------------------------ run: --json

#[test]
fn dry_run_json_is_pure_ndjson_on_stdout() {
    let e = Env::new();
    staged_workspace(&e, "        default: continue");
    let out = e.run(&["run", "staged", "--dry-run", "--json", "--yes"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    let lines: Vec<serde_json::Value> = out
        .stdout()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{e}: {l:?}")))
        .collect();
    assert_eq!(lines.first().unwrap()["type"], "run:start");
    assert_eq!(lines.last().unwrap()["type"], "run:done");
}

// ------------------------------------------------------------------ run: cancellation

#[cfg(unix)]
#[test]
fn sigint_cancels_the_run_and_ends_its_tree() {
    let e = Env::new();
    let marker = e.ws().join("grandchild.pid");
    e.write(
        ".whiphand/workflows/slow.yaml",
        &format!(
            "name: slow\nsteps:\n  - id: wait\n    kind: command\n    run: sleep 30 & echo $! > '{}'; wait\n    output: wait.log\n",
            marker.display()
        ),
    );
    let ws = e.ws().to_string_lossy().into_owned();
    let child = e
        .command(&["run", "slow", "-C", &ws], e.ws())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = std::time::Instant::now();
    while !std::fs::read_to_string(&marker).is_ok_and(|s| !s.trim().is_empty()) {
        assert!(started.elapsed().as_secs() < 10, "the step never started");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let grandchild = std::fs::read_to_string(&marker).unwrap().trim().to_string();
    Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .unwrap();
    let out = Out(child.wait_with_output().unwrap());
    assert_eq!(out.code(), 1, "a cancelled run is not ok");
    // Well inside the container's 5 s kill grace: the tree ends on the signal.
    assert!(started.elapsed().as_secs() < 3, "{:?}", started.elapsed());
    assert!(out.stdout().contains("✖ run cancelled"), "{}", out.stdout());
    let alive = Command::new("kill")
        .args(["-0", &grandchild])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success();
    assert!(!alive, "grandchild {grandchild} outlived the run");
}

// ------------------------------------------------------------------ config

#[test]
fn config_get_prints_the_resolved_config_or_one_key() {
    let e = Env::new();
    let out = e.run(&["config", "get"]);
    assert_eq!(out.code(), 0);
    assert_eq!(
        out.stdout(),
        "defaults:\n  runner: claude\non_findings: report\nloop:\n  max_iterations: 3\nartifacts_dir: .whiphand/runs\nruns:\n  max_retained: null\n  auto_name: false\n  max_attachment_mb: 25\n"
    );
    let out = e.run(&["config", "get", "loop.max_iterations"]);
    assert_eq!(out.stdout(), "3\n");
    let out = e.run(&["config", "get", "nope.field"]);
    assert_eq!(out.code(), 2);
}

#[test]
fn config_set_writes_the_project_layer_and_get_reflects_it() {
    let e = Env::new();
    let out = e.run(&["config", "set", "loop.max_iterations", "7"]);
    assert_eq!(out.code(), 0);
    assert_eq!(out.stdout(), "set loop.max_iterations = 7 (project)\n");
    assert_eq!(e.project_config().unwrap(), "loop:\n  max_iterations: 7\n");
    assert_eq!(
        e.run(&["config", "get", "loop.max_iterations"]).stdout(),
        "7\n"
    );
}

#[test]
fn config_set_global_is_visible_from_any_workspace() {
    let e = Env::new();
    let out = e.run(&["config", "set", "defaults.runner", "copilot", "--global"]);
    assert_eq!(out.code(), 0);
    assert_eq!(
        std::fs::read_to_string(e.home.path().join("config.yaml")).unwrap(),
        "defaults:\n  runner: copilot\n"
    );
    let other = Env {
        home: e.home,
        ws: tempfile::tempdir().unwrap(),
    };
    assert_eq!(
        other.run(&["config", "get", "defaults.runner"]).stdout(),
        "copilot\n"
    );
}

#[test]
fn config_set_writes_only_what_differs_from_the_layer_beneath() {
    let e = Env::new();
    std::fs::write(
        e.home.path().join("config.yaml"),
        "defaults: { runner: copilot }\n",
    )
    .unwrap();
    assert_eq!(
        e.run(&["config", "set", "defaults.runner", "copilot"])
            .code(),
        0
    );
    assert_eq!(e.project_config().unwrap(), "{}\n");
}

#[test]
fn config_set_max_retained_null() {
    let e = Env::new();
    assert_eq!(
        e.run(&["config", "set", "runs.max_retained", "5"]).code(),
        0
    );
    assert_eq!(e.project_config().unwrap(), "runs:\n  max_retained: 5\n");
    // null is the default already, so the layer collapses rather than pinning it.
    assert_eq!(
        e.run(&["config", "set", "runs.max_retained", "null"])
            .code(),
        0
    );
    assert_eq!(e.project_config().unwrap(), "{}\n");
    assert_eq!(
        e.run(&["config", "get", "runs.max_retained"]).stdout(),
        "null\n"
    );

    // Against a global cap, null is a real override.
    let e = Env::new();
    std::fs::write(
        e.home.path().join("config.yaml"),
        "runs: { max_retained: 10 }\n",
    )
    .unwrap();
    assert_eq!(
        e.run(&["config", "set", "runs.max_retained", "null"])
            .code(),
        0
    );
    assert_eq!(e.project_config().unwrap(), "runs:\n  max_retained: null\n");
}

#[test]
fn config_set_rejects_invalid_values_and_writes_nothing() {
    let e = Env::new();
    for (key, value) in [
        ("loop.max_iterations", "not-a-number"),
        ("on_findings", "nonsense"),
        ("runs.max_retained", "0"),
        ("runs.max_attachment_mb", "0"),
        ("runs.max_attachment_mb", "lots"),
        ("runs.auto_name", "yes"),
        ("defaults.runner", ""),
    ] {
        let out = e.run(&["config", "set", key, value]);
        assert_eq!(out.code(), 2, "{key}={value}");
    }
    assert_eq!(e.project_config(), None);
    assert_eq!(
        e.run(&["config", "set", "runs.max_attachment_mb", "0.5"])
            .code(),
        0
    );
    assert_eq!(
        e.project_config().unwrap(),
        "runs:\n  max_attachment_mb: 0.5\n"
    );
}

// ------------------------------------------------------------------ init, new-workflow, rename-run

#[test]
fn init_then_new_workflow() {
    let e = Env::new();
    let out = e.run(&["init"]);
    assert_eq!(out.code(), 0);
    assert!(out.stdout().contains("created "), "{}", out.stdout());
    assert_eq!(
        e.run(&["init"]).stdout(),
        "workspace already initialized — nothing to do\n"
    );
    let out = e.run(&["new-workflow", "triage"]);
    assert_eq!(out.code(), 0);
    let text = std::fs::read_to_string(e.ws().join(".whiphand/workflows/triage.yaml")).unwrap();
    assert!(text.contains("\nname: triage\n"));
    let out = e.run(&["new-workflow", "triage"]);
    assert_eq!(out.code(), 1);
    assert!(
        out.stderr()
            .starts_with("Error: workflow 'triage' already exists at ")
    );
}

#[test]
fn rename_run_sets_and_clears_a_name() {
    let e = Env::new();
    let out = e.run(&["rename-run", RUN_ID, "x"]);
    assert_eq!(out.code(), 2);
    assert_eq!(
        out.stderr(),
        format!("✘ no run '{RUN_ID}' under .whiphand/runs\n")
    );
    std::fs::create_dir_all(e.runs_dir().join(RUN_ID)).unwrap();
    assert_eq!(
        e.run(&["rename-run", RUN_ID, "  Ship  it "]).stdout(),
        format!("{RUN_ID} — Ship it\n")
    );
    assert_eq!(
        e.run(&["rename-run", RUN_ID, ""]).stdout(),
        format!("{RUN_ID} — name cleared\n")
    );
}

#[test]
fn version_is_the_core_version() {
    let e = Env::new();
    let out = Out(e.command(&["--version"], e.ws()).output().unwrap());
    assert_eq!(
        out.stdout(),
        format!("{}\n", whiphand_core::engine::runner::CORE_VERSION)
    );
}
