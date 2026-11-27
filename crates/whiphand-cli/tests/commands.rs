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
    // The child's cwd is the directory's real path: macOS's temp dir is
    // /var/…, a symlink to /private/var/….
    let shell_dir = if cfg!(windows) {
        shell.path().to_path_buf()
    } else {
        std::fs::canonicalize(shell.path()).unwrap()
    };
    let source = shell_dir.join("bug.png").to_string_lossy().into_owned();
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

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[test]
fn init_without_a_terminal_defaults_to_local_storage_and_workflows() {
    let e = Env::new();
    let out = e.run(&["init"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(e.ws().join(".whiphand/config.yaml").is_file());
    assert_eq!(
        names(&e.ws().join(".whiphand/workflows")),
        [
            "author-workflow.yaml",
            "develop.yaml",
            "iterate.yaml",
            "research.yaml"
        ]
    );
    assert!(!e.home.path().join("workflows").exists());
    assert!(out.stdout().contains("data: "), "{}", out.stdout());
}

#[test]
fn init_user_storage_with_global_workflows() {
    let e = Env::new();
    std::fs::create_dir_all(e.home.path().join("workflows")).unwrap();
    std::fs::write(e.home.path().join("workflows/iterate.yaml"), "mine").unwrap();
    let out = e.run(&["init", "--storage", "user", "--workflows", "global"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(names(e.ws()).is_empty());
    assert_eq!(
        std::fs::read_to_string(e.home.path().join("workflows/iterate.yaml")).unwrap(),
        "mine"
    );
    assert_eq!(
        names(&e.home.path().join("workflows")),
        [
            "author-workflow.yaml",
            "develop.yaml",
            "iterate.yaml",
            "research.yaml"
        ]
    );
    // a re-run keeps the storage and creates nothing; the other mode is refused
    let again = e.run(&["init", "--workflows", "global"]);
    assert_eq!(again.code(), 0, "{}", again.stderr());
    assert!(again.stdout().starts_with("workspace already initialized"));
    let switch = e.run(&["init", "--storage", "local"]);
    assert_eq!(switch.code(), 1);
    assert!(
        switch.stderr().contains("not supported yet"),
        "{}",
        switch.stderr()
    );
    assert!(names(e.ws()).is_empty());
}

#[test]
fn init_user_storage_with_local_workflows_keeps_everything_in_the_user_folder() {
    let e = Env::new();
    let out = e.run(&["init", "--storage", "user", "--workflows", "local"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(names(e.ws()).is_empty());
    assert!(!e.home.path().join("workflows").exists());
}

#[test]
fn init_rejects_unknown_flag_values() {
    let e = Env::new();
    assert_ne!(e.run(&["init", "--storage", "cloud"]).code(), 0);
    assert_ne!(e.run(&["init", "--workflows", "x"]).code(), 0);
    assert!(names(e.ws()).is_empty());
}

#[test]
fn init_then_new_workflow() {
    let e = Env::new();
    let out = e.run(&["init"]);
    assert_eq!(out.code(), 0);
    assert!(out.stdout().contains("created "), "{}", out.stdout());
    assert!(
        e.run(&["init"])
            .stdout()
            .starts_with("workspace already initialized — nothing to do\n")
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

const AUTHORED: &str = "# drafted by an agent\nname: draft\n\nsteps:\n  # the only step\n  - id: a\n    kind: command\n    run: echo a\n";

#[test]
fn new_workflow_from_a_file_renames_it_and_keeps_its_comments() {
    let e = Env::new();
    e.write("x.yaml", AUTHORED);
    let out = e.run(&["new-workflow", "demo", "--from", "x.yaml"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    let path = e.ws().join(".whiphand/workflows/demo.yaml");
    // Compare as paths, not strings: the binary prints native separators
    // (`\` on Windows) while `join` above keeps the `/` as written.
    let stdout = out.stdout();
    let printed = stdout
        .strip_prefix("created ")
        .and_then(|s| s.strip_suffix('\n'))
        .unwrap_or_else(|| panic!("unexpected stdout: {stdout:?}"));
    assert_eq!(Path::new(printed), path);
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text, AUTHORED.replace("name: draft", "name: demo"));
}

#[test]
fn new_workflow_from_a_file_writes_the_chosen_scope() {
    let e = Env::new();
    e.write("x.yaml", AUTHORED);
    let out = e.run(&["new-workflow", "demo", "--from", "x.yaml", "--global"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    let global = e.home.path().join("workflows/demo.yaml");
    assert!(global.is_file());
    let out = e.run(&["new-workflow", "demo", "--from", "x.yaml", "--workspace"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    let written = out
        .stdout()
        .trim_end()
        .strip_prefix("created ")
        .unwrap()
        .to_string();
    let written = Path::new(&written);
    assert!(written.is_file(), "{}", written.display());
    assert!(written.starts_with(e.home.path()), "{}", written.display());
    assert_ne!(written, global);
    assert!(written.ends_with("workflows/demo.yaml"));
    assert!(!e.ws().join(".whiphand/workflows/demo.yaml").exists());
}

#[test]
fn new_workflow_from_refuses_an_existing_name_unless_replace() {
    let e = Env::new();
    e.write("x.yaml", AUTHORED);
    assert_eq!(
        e.run(&["new-workflow", "demo", "--from", "x.yaml"]).code(),
        0
    );
    let out = e.run(&["new-workflow", "demo", "--from", "x.yaml"]);
    assert_eq!(out.code(), 1);
    assert!(
        out.stderr()
            .starts_with("Error: workflow 'demo' already exists at "),
        "{}",
        out.stderr()
    );
    e.write("y.yaml", &AUTHORED.replace("echo a", "echo b"));
    let out = e.run(&["new-workflow", "demo", "--from", "y.yaml", "--replace"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    let text = std::fs::read_to_string(e.ws().join(".whiphand/workflows/demo.yaml")).unwrap();
    assert!(
        text.contains("echo b") && text.contains("name: demo"),
        "{text}"
    );
    // --replace on a name that does not exist yet simply creates it.
    let out = e.run(&["new-workflow", "other", "--from", "x.yaml", "--replace"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(e.ws().join(".whiphand/workflows/other.yaml").is_file());
}

#[test]
fn new_workflow_from_an_invalid_file_prints_problems_and_writes_nothing() {
    let e = Env::new();
    e.write("bad.yaml", "name: bad\nsteps: []\n");
    let out = e.run(&["new-workflow", "demo", "--from", "bad.yaml", "--replace"]);
    assert_eq!(out.code(), 1, "{}{}", out.stdout(), out.stderr());
    assert!(out.stdout().is_empty(), "{}", out.stdout());
    assert!(out.stderr().starts_with("error: "), "{}", out.stderr());
    assert!(out.stderr().contains("nothing written"), "{}", out.stderr());
    assert!(!e.ws().join(".whiphand").exists());
    e.write("syntax.yaml", "name: [unclosed\n");
    let out = e.run(&["new-workflow", "demo", "--from", "syntax.yaml"]);
    assert_eq!(out.code(), 1);
    assert!(
        out.stderr().contains("YAML parse error"),
        "{}",
        out.stderr()
    );
    assert!(!e.ws().join(".whiphand").exists());
}

const STOCK_ITERATE: &str = include_str!("../../whiphand-core/templates/iterate.yaml");
const STOCK_DEVELOP: &str = include_str!("../../whiphand-core/templates/develop.yaml");

/// The `<name>  <text>` lines `restore-workflows` printed, as pairs.
fn restore_rows(out: &Out) -> Vec<(String, String)> {
    out.stdout()
        .lines()
        .map(|l| {
            let (name, text) = l.split_once(' ').unwrap();
            (name.to_string(), text.trim_start().to_string())
        })
        .collect()
}

#[test]
fn restore_workflows_brings_back_a_deleted_one_and_keeps_the_rest() {
    let e = Env::new();
    assert_eq!(e.run(&["init"]).code(), 0);
    let wf = e.ws().join(".whiphand/workflows");
    std::fs::remove_file(wf.join("develop.yaml")).unwrap();
    let out = e.run(&["restore-workflows"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    let rows = restore_rows(&out);
    assert_eq!(rows.len(), 4, "{}", out.stdout());
    assert_eq!(rows[0].0, "iterate");
    assert!(rows[0].1.starts_with("kept"), "{}", out.stdout());
    assert_eq!(rows[1], ("develop".into(), "added".into()));
    assert_eq!(rows[2].0, "research");
    assert!(rows[2].1.starts_with("kept"), "{}", out.stdout());
    assert_eq!(rows[3].0, "author-workflow");
    assert!(rows[3].1.starts_with("kept"), "{}", out.stdout());
    assert_eq!(
        std::fs::read_to_string(wf.join("develop.yaml")).unwrap(),
        STOCK_DEVELOP
    );
}

#[test]
fn restore_workflows_lists_keeps_and_replaces_an_edited_one() {
    let e = Env::new();
    assert_eq!(e.run(&["init"]).code(), 0);
    let iterate = e.ws().join(".whiphand/workflows/iterate.yaml");
    let edited = STOCK_ITERATE.replace("description:", "description: edited.");
    std::fs::write(&iterate, &edited).unwrap();

    let out = e.run(&["restore-workflows", "--list"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert_eq!(
        restore_rows(&out),
        [
            ("iterate".into(), "modified".into()),
            ("develop".into(), "stock".into()),
            ("research".into(), "stock".into()),
            ("author-workflow".into(), "stock".into())
        ]
    );

    let out = e.run(&["restore-workflows"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(restore_rows(&out)[0].1.starts_with("kept"));
    assert_eq!(std::fs::read_to_string(&iterate).unwrap(), edited);

    let out = e.run(&["restore-workflows", "iterate", "--replace"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert_eq!(restore_rows(&out), [("iterate".into(), "replaced".into())]);
    assert_eq!(std::fs::read_to_string(&iterate).unwrap(), STOCK_ITERATE);
    let out = e.run(&["restore-workflows", "--list", "iterate"]);
    assert_eq!(restore_rows(&out), [("iterate".into(), "stock".into())]);
}

#[test]
fn restore_workflows_global_and_workspace_act_on_their_scope_only() {
    let e = Env::new();
    let out = e.run(&["restore-workflows", "--global"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(restore_rows(&out).iter().all(|(_, t)| t == "added"));
    assert_eq!(
        names(&e.home.path().join("workflows")),
        [
            "author-workflow.yaml",
            "develop.yaml",
            "iterate.yaml",
            "research.yaml"
        ]
    );
    assert!(names(e.ws()).is_empty());
    let out = e.run(&["restore-workflows", "--list"]);
    assert!(restore_rows(&out).iter().all(|(_, t)| t == "missing"));

    let out = e.run(&["restore-workflows", "research", "--workspace"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert_eq!(restore_rows(&out), [("research".into(), "added".into())]);
    assert!(names(e.ws()).is_empty());
    let out = e.run(&["restore-workflows", "--list", "--workspace"]);
    assert_eq!(
        restore_rows(&out),
        [
            ("iterate".into(), "missing".into()),
            ("develop".into(), "missing".into()),
            ("research".into(), "stock".into()),
            ("author-workflow".into(), "missing".into())
        ]
    );
    // The global dir still holds only what the first restore wrote.
    assert_eq!(names(&e.home.path().join("workflows")).len(), 4);
}

#[test]
fn restore_workflows_refuses_an_unknown_name_and_writes_nothing() {
    let e = Env::new();
    let out = e.run(&["restore-workflows", "develop", "nope"]);
    assert_eq!(out.code(), 2, "{}{}", out.stdout(), out.stderr());
    assert!(out.stdout().is_empty(), "{}", out.stdout());
    assert!(
        out.stderr().contains(
            "'nope'; the shipped workflows are: iterate, develop, research, author-workflow"
        ),
        "{}",
        out.stderr()
    );
    assert!(names(e.ws()).is_empty());
    assert!(!e.home.path().join("workflows").exists());
    let out = e.run(&["restore-workflows", "--list", "--replace"]);
    assert_ne!(out.code(), 0);
}

#[test]
fn new_workflow_from_refuses_an_invalid_name_and_a_missing_file() {
    let e = Env::new();
    e.write("x.yaml", AUTHORED);
    let out = e.run(&["new-workflow", "Bad Name", "--from", "x.yaml"]);
    assert_eq!(out.code(), 1);
    assert!(out.stderr().starts_with("Error: "), "{}", out.stderr());
    assert_eq!(
        out.stderr(),
        e.run(&["new-workflow", "Bad Name"]).stderr(),
        "the same refusal as without --from"
    );
    let out = e.run(&["new-workflow", "demo", "--from", "nope.yaml"]);
    assert_eq!(out.code(), 2);
    assert!(out.stderr().contains("no such file"), "{}", out.stderr());
    assert!(!e.ws().join(".whiphand").exists());
    // --replace means nothing without --from.
    assert_ne!(e.run(&["new-workflow", "demo", "--replace"]).code(), 0);
    assert!(!e.ws().join(".whiphand").exists());
}

#[test]
fn new_workflow_from_stdin() {
    use std::io::Write;
    let e = Env::new();
    let ws = e.ws().to_string_lossy().into_owned();
    let mut child = e
        .command(&["new-workflow", "demo", "--from", "-", "-C", &ws], e.ws())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(AUTHORED.as_bytes())
        .unwrap();
    let out = Out(child.wait_with_output().unwrap());
    assert_eq!(out.code(), 0, "{}", out.stderr());
    let text = std::fs::read_to_string(e.ws().join(".whiphand/workflows/demo.yaml")).unwrap();
    assert_eq!(text, AUTHORED.replace("name: draft", "name: demo"));
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

// ------------------------------------------------------------------ run: worktree

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A git workspace with one commit. `.whiphand/` is ignored, as a user's would be.
fn git_workspace(e: &Env) {
    git(e.ws(), &["init", "-q"]);
    git(e.ws(), &["config", "user.name", "T"]);
    git(e.ws(), &["config", "user.email", "t@example.com"]);
    e.write(".gitignore", ".whiphand/\n");
    e.write("tracked.txt", "x\n");
    e.write(".whiphand/config.yaml", "runs:\n  auto_name: false\n");
    git(e.ws(), &["add", "."]);
    git(e.ws(), &["commit", "-q", "-m", "init"]);
}

fn worktree_workflow(e: &Env, worktree: &str, run: &str) {
    e.write(
        ".whiphand/workflows/wt.yaml",
        &format!(
            "name: wt\n{worktree}steps:\n  - id: go\n    kind: command\n    run: {}\n    output: go.log\n",
            serde_json::to_string(run).unwrap()
        ),
    );
}

/// Records the step's cwd. `pwd -W` gives Git Bash's native `D:/...` form; plain `pwd`
/// there gives `/d/...`, which Windows cannot canonicalize. Other shells reject `-W`.
macro_rules! record_pwd {
    () => {
        "{ pwd -W 2>/dev/null || pwd; } > \"$WHIPHAND_RUN_DIR/pwd.txt\""
    };
}

const RECORD_BRANCH_AND_PWD: &str = concat!(
    "git rev-parse --abbrev-ref HEAD > \"$WHIPHAND_RUN_DIR/branch.txt\" && ",
    record_pwd!()
);

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap()
}

fn recorded(run: &Path, name: &str) -> String {
    std::fs::read_to_string(run.join(name))
        .unwrap()
        .trim()
        .to_string()
}

/// A run's worktree folder when it has no usable name: its id's random suffix.
fn wt_suffix(id: &str) -> String {
    id.rsplit('-').next().unwrap().to_string()
}

fn run_id(run: &Path) -> String {
    run.file_name().unwrap().to_string_lossy().into_owned()
}

#[test]
fn worktree_run_executes_on_a_new_branch_in_the_worktree() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "worktree: true\n", RECORD_BRANCH_AND_PWD);
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let run = e.only_run();
    let id = run_id(&run);
    assert_eq!(recorded(&run, "branch.txt"), format!("whiphand/{id}"));
    let expected = e.ws().join(".whiphand/wt").join(wt_suffix(&id));
    assert_eq!(
        canonical(Path::new(&recorded(&run, "pwd.txt"))),
        canonical(&expected)
    );
    assert!(e.ws().join(".whiphand/wt/.gitignore").is_file());
}

#[test]
fn named_run_worktree_folder_carries_the_slug_and_resume_and_remove_use_it() {
    let e = Env::new();
    git_workspace(&e);
    let flaky = concat!(
        record_pwd!(),
        " && test -f \"$WHIPHAND_RUN_DIR/ok\" || { touch \"$WHIPHAND_RUN_DIR/ok\"; exit 1; }"
    );
    worktree_workflow(&e, "worktree: true\n", flaky);
    let out = e.run(&["run", "wt", "--name", "Fix login bug"]);
    assert_eq!(out.code(), 1, "{}{}", out.stdout(), out.stderr());
    let id = run_id(&e.only_run());
    let tree = e
        .ws()
        .join(".whiphand/wt")
        .join(format!("{}-fix-login-bug", wt_suffix(&id)));
    assert!(tree.is_dir(), "{}", out.stdout());
    assert!(
        out.stdout()
            .contains(&format!(".whiphand/wt/{}-fix-login-bug", wt_suffix(&id))),
        "{}",
        out.stdout()
    );
    let out = e.run(&["run", "--resume", &id]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let out = e.run(&["worktree", "remove", &id]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(!tree.exists());
}

#[test]
fn worktree_flag_creates_a_worktree_for_a_workflow_without_the_field() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "", RECORD_BRANCH_AND_PWD);
    let out = e.run(&["run", "wt", "--worktree"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let run = e.only_run();
    let id = run_id(&run);
    assert_eq!(recorded(&run, "branch.txt"), format!("whiphand/{id}"));
    assert!(
        out.stdout().contains(&format!(
            "🌿 worktree .whiphand/wt/{} on branch whiphand/{id}",
            wt_suffix(&id)
        )),
        "{}",
        out.stdout()
    );
}

#[test]
fn no_worktree_flag_runs_in_the_workspace_despite_the_workflow() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "worktree: true\n", RECORD_BRANCH_AND_PWD);
    let out = e.run(&["run", "wt", "--no-worktree"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let run = e.only_run();
    assert_eq!(
        canonical(Path::new(&recorded(&run, "pwd.txt"))),
        canonical(e.ws())
    );
    assert!(!out.stdout().contains("🌿"), "{}", out.stdout());
    assert!(
        !e.ws()
            .join(".whiphand/wt")
            .join(wt_suffix(&run_id(&run)))
            .exists()
    );
}

#[test]
fn worktree_flags_are_refused_with_resume_and_with_each_other() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "", "true");
    for flag in ["--worktree", "--no-worktree"] {
        let out = e.run(&["run", "--resume", "x", flag]);
        assert_ne!(out.code(), 0, "{flag}");
        assert!(
            out.stderr().contains("cannot be used with"),
            "{}",
            out.stderr()
        );
    }
    let out = e.run(&["run", "wt", "--worktree", "--no-worktree"]);
    assert_ne!(out.code(), 0);
    assert!(
        !e.ws().join(".whiphand/runs").exists()
            || std::fs::read_dir(e.ws().join(".whiphand/runs"))
                .unwrap()
                .next()
                .is_none()
    );
}

/// `main` pushed to a bare local `origin`; returns the temp dir that owns it.
fn with_origin(e: &Env) -> TempDir {
    git(e.ws(), &["branch", "-M", "main"]);
    let remote = tempfile::tempdir().unwrap();
    let origin = remote.path().join("origin.git");
    git(
        remote.path(),
        &["init", "-q", "--bare", origin.to_str().unwrap()],
    );
    git(
        e.ws(),
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    git(e.ws(), &["push", "-q", "-u", "origin", "main"]);
    remote
}

/// A commit on `origin`'s `main` made from a second clone; returns its sha.
fn advance_origin(remote: &TempDir) -> String {
    let other = remote.path().join("other");
    let origin = remote.path().join("origin.git");
    git(
        remote.path(),
        &[
            "clone",
            "-q",
            "-b",
            "main",
            origin.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    git(&other, &["config", "user.name", "T"]);
    git(&other, &["config", "user.email", "t@example.com"]);
    std::fs::write(other.join("remote.txt"), "r\n").unwrap();
    git(&other, &["add", "."]);
    git(&other, &["commit", "-q", "-m", "remote"]);
    git(&other, &["push", "-q", "origin", "main"]);
    git(&other, &["rev-parse", "HEAD"]).trim().to_string()
}

fn rev(dir: &Path, name: &str) -> String {
    git(dir, &["rev-parse", name]).trim().to_string()
}

const BASE_MAIN: &str = "worktree:\n  base: main\n";

fn manifest_of(run: &Path) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(run.join("run.json")).unwrap()).unwrap()
}

fn sync_degradations(run: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(run.join("events.ndjson"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap()["event"].clone())
        .filter(|v| v["type"] == "run:degraded" && v["capability"] == "worktree-sync")
        .collect()
}

#[test]
fn worktree_starts_from_the_fetched_upstream_and_leaves_local_main_alone() {
    let e = Env::new();
    git_workspace(&e);
    let remote = with_origin(&e);
    let local_main = rev(e.ws(), "main");
    let tip = advance_origin(&remote);
    worktree_workflow(&e, BASE_MAIN, "true");
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let run = e.only_run();
    let m = manifest_of(&run);
    assert_eq!(m["worktree"]["startedFrom"], "origin/main");
    assert_eq!(m["worktree"]["baseSha"], tip);
    assert_eq!(rev(e.ws(), m["worktree"]["branch"].as_str().unwrap()), tip);
    assert_eq!(rev(e.ws(), "refs/heads/main"), local_main);
    assert!(sync_degradations(&run).is_empty());
}

#[test]
fn two_worktree_runs_on_main_leave_it_checked_out_only_in_the_main_tree() {
    let e = Env::new();
    git_workspace(&e);
    let _remote = with_origin(&e);
    worktree_workflow(&e, BASE_MAIN, "true");
    for _ in 0..2 {
        let out = e.run(&["run", "wt"]);
        assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    }
    let listed = git(e.ws(), &["worktree", "list", "--porcelain"]);
    let on_main = listed
        .lines()
        .filter(|l| *l == "branch refs/heads/main")
        .count();
    assert_eq!(on_main, 1, "{listed}");
    assert!(listed.lines().next().unwrap().starts_with("worktree "));
    let first_block: Vec<&str> = listed.split("\n\n").next().unwrap().lines().collect();
    assert!(first_block.contains(&"branch refs/heads/main"), "{listed}");
}

#[test]
fn worktree_falls_back_to_local_main_when_the_remote_is_unreachable() {
    let e = Env::new();
    git_workspace(&e);
    let remote = with_origin(&e);
    git(
        e.ws(),
        &[
            "remote",
            "set-url",
            "origin",
            remote.path().join("gone.git").to_str().unwrap(),
        ],
    );
    let local_main = rev(e.ws(), "main");
    worktree_workflow(&e, BASE_MAIN, "true");
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let run = e.only_run();
    let m = manifest_of(&run);
    assert_eq!(m["worktree"]["baseSha"], local_main);
    assert_eq!(m["worktree"]["startedFrom"], "main");
    assert_eq!(sync_degradations(&run).len(), 1);
}

#[test]
fn worktree_falls_back_to_local_main_when_it_is_ahead_of_the_remote() {
    let e = Env::new();
    git_workspace(&e);
    let _remote = with_origin(&e);
    e.write("ahead.txt", "a\n");
    git(e.ws(), &["add", "."]);
    git(e.ws(), &["commit", "-q", "-m", "ahead"]);
    let local_main = rev(e.ws(), "main");
    worktree_workflow(&e, BASE_MAIN, "true");
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let run = e.only_run();
    let m = manifest_of(&run);
    assert_eq!(m["worktree"]["baseSha"], local_main);
    assert_eq!(m["worktree"]["startedFrom"], "main");
    let degraded = sync_degradations(&run);
    assert_eq!(degraded.len(), 1, "{degraded:?}");
    assert!(degraded[0]["reason"].as_str().unwrap().contains("not in"));
}

#[test]
fn worktree_sync_false_does_not_fetch() {
    let e = Env::new();
    git_workspace(&e);
    let remote = with_origin(&e);
    let local_main = rev(e.ws(), "main");
    let tracking = rev(e.ws(), "refs/remotes/origin/main");
    advance_origin(&remote);
    worktree_workflow(&e, "worktree:\n  base: main\n  sync: false\n", "true");
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let run = e.only_run();
    let m = manifest_of(&run);
    assert_eq!(m["worktree"]["baseSha"], local_main);
    assert_eq!(m["worktree"]["startedFrom"], "main");
    assert_eq!(rev(e.ws(), "refs/remotes/origin/main"), tracking);
    assert!(sync_degradations(&run).is_empty());
}

#[test]
fn worktree_from_head_neither_fetches_nor_degrades() {
    let e = Env::new();
    git_workspace(&e);
    let remote = with_origin(&e);
    let tracking = rev(e.ws(), "refs/remotes/origin/main");
    advance_origin(&remote);
    worktree_workflow(&e, "worktree: true\n", "true");
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let run = e.only_run();
    let m = manifest_of(&run);
    assert_eq!(m["worktree"]["startedFrom"], "HEAD");
    assert_eq!(rev(e.ws(), "refs/remotes/origin/main"), tracking);
    assert!(sync_degradations(&run).is_empty());
}

#[test]
fn worktree_run_keeps_the_main_tree_clean() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "worktree: true\n", "echo hi > new.txt");
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let id = run_id(&e.only_run());
    assert!(
        e.ws()
            .join(".whiphand/wt")
            .join(wt_suffix(&id))
            .join("new.txt")
            .is_file()
    );
    assert!(!e.ws().join("new.txt").exists());
    assert_eq!(git(e.ws(), &["status", "--porcelain"]), "");
}

#[test]
fn worktree_in_a_directory_that_is_not_a_repo_is_refused_without_a_run() {
    let e = Env::new();
    e.write(".whiphand/config.yaml", "runs:\n  auto_name: false\n");
    worktree_workflow(&e, "worktree: true\n", "true");
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 1, "{}", out.stderr());
    assert!(
        out.stderr().contains("is not a git repository"),
        "{}",
        out.stderr()
    );
    assert!(
        out.stderr()
            .contains(&e.ws().to_string_lossy().into_owned())
    );
    assert!(!e.runs_dir().exists());
}

/// A workspace that is not a repository, holding the repository `api`.
fn multi_repo_workspace(e: &Env) {
    e.write(".whiphand/config.yaml", "runs:\n  auto_name: false\n");
    e.write("api/tracked.txt", "x\n");
    let api = e.ws().join("api");
    git(&api, &["init", "-q"]);
    git(&api, &["config", "user.name", "T"]);
    git(&api, &["config", "user.email", "t@example.com"]);
    git(&api, &["add", "."]);
    git(&api, &["commit", "-q", "-m", "init"]);
}

#[test]
fn in_runs_a_worktree_from_the_repository_below_the_workspace() {
    let e = Env::new();
    multi_repo_workspace(&e);
    worktree_workflow(&e, "worktree: true\n", "echo hi > new.txt");
    let out = e.run(&["run", "wt", "--subdir", "api"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let run = e.only_run();
    let id = run_id(&run);
    assert_eq!(manifest_of(&run)["subdir"], "api");
    assert!(
        e.ws()
            .join(".whiphand/wt")
            .join(wt_suffix(&id))
            .join("new.txt")
            .is_file()
    );
    assert!(git(&e.ws().join("api"), &["branch", "--list"]).contains(&format!("whiphand/{id}")));
    assert!(!out.stderr().contains("pass --subdir"), "{}", out.stderr());
}

#[test]
fn a_run_at_a_root_that_is_not_a_repository_names_the_ones_below_it() {
    let e = Env::new();
    multi_repo_workspace(&e);
    worktree_workflow(&e, "", "true");
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    assert!(
        out.stderr().contains("pass --subdir <dir> (api)"),
        "{}",
        out.stderr()
    );
}

#[test]
fn in_outside_the_workspace_is_a_usage_error_without_a_run() {
    let e = Env::new();
    multi_repo_workspace(&e);
    worktree_workflow(&e, "", "true");
    let out = e.run(&["run", "wt", "--subdir", "../elsewhere"]);
    assert_eq!(out.code(), 2, "{}", out.stderr());
    assert!(
        out.stderr().contains("work directory '../elsewhere'"),
        "{}",
        out.stderr()
    );
    assert!(!e.runs_dir().exists());
}

#[test]
fn in_with_resume_is_refused() {
    let e = Env::new();
    let out = e.run(&["run", "--resume", "r1", "--subdir", "api"]);
    assert_ne!(out.code(), 0);
    assert!(
        out.stderr().contains("cannot be used with"),
        "{}",
        out.stderr()
    );
}

#[test]
fn worktree_with_an_unknown_base_is_refused_without_a_run() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "worktree:\n  base: nope\n", "true");
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 1, "{}", out.stderr());
    assert!(
        out.stderr().contains("base 'nope' is not a commit"),
        "{}",
        out.stderr()
    );
    assert!(!e.runs_dir().exists());
}

#[test]
fn worktree_branch_that_already_exists_fails_the_run() {
    let e = Env::new();
    git_workspace(&e);
    git(e.ws(), &["branch", "taken"]);
    worktree_workflow(&e, "worktree:\n  branch: taken\n", "true");
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 1, "{}{}", out.stdout(), out.stderr());
    assert!(
        out.stderr().contains("branch 'taken' already exists"),
        "{}",
        out.stderr()
    );
    assert!(
        !e.ws()
            .join(".whiphand/wt")
            .join(wt_suffix(&run_id(&e.only_run())))
            .exists()
    );
}

#[test]
fn resume_returns_to_the_same_worktree_and_refuses_a_missing_one() {
    let e = Env::new();
    git_workspace(&e);
    let flaky = concat!(
        record_pwd!(),
        " && test -f \"$WHIPHAND_RUN_DIR/ok\" || { touch \"$WHIPHAND_RUN_DIR/ok\"; exit 1; }"
    );
    worktree_workflow(&e, "worktree: true\n", flaky);
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 1, "{}{}", out.stdout(), out.stderr());
    let run = e.only_run();
    let id = run_id(&run);
    let first = recorded(&run, "pwd.txt");

    let out = e.run(&["run", "--resume", &id]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    assert_eq!(
        canonical(Path::new(&recorded(&run, "pwd.txt"))),
        canonical(Path::new(&first))
    );
    assert_eq!(git(e.ws(), &["status", "--porcelain"]), "");

    // A finished run cannot be resumed, so fail it again, then remove its worktree.
    std::fs::remove_file(run.join("ok")).unwrap();
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 1, "{}{}", out.stdout(), out.stderr());
    let second = e
        .runs_dir()
        .read_dir()
        .unwrap()
        .flatten()
        .map(|d| d.path())
        .find(|p| *p != run)
        .unwrap();
    let second_id = run_id(&second);
    let tree = e.ws().join(".whiphand/wt").join(wt_suffix(&second_id));
    git(
        e.ws(),
        &["worktree", "remove", "--force", &tree.to_string_lossy()],
    );
    let out = e.run(&["run", "--resume", &second_id]);
    assert_eq!(out.code(), 1, "{}{}", out.stdout(), out.stderr());
    assert!(
        out.stderr().contains("no longer exists"),
        "{}",
        out.stderr()
    );
}

#[test]
fn worktree_is_recorded_in_run_json_and_run_start_is_workspace_relative() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "worktree: true\n", "true");
    let out = e.run(&["run", "wt", "--json"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    let run = e.only_run();
    let id = run_id(&run);
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("run.json")).unwrap()).unwrap();
    for key in ["path", "tree", "branch", "base", "baseSha"] {
        assert!(
            manifest["worktree"][key]
                .as_str()
                .is_some_and(|s| !s.is_empty()),
            "{key}: {manifest}"
        );
    }
    let start: serde_json::Value = out
        .stdout()
        .lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
        .find(|v| v["type"] == "run:start")
        .unwrap();
    assert_eq!(
        start["worktree"]["path"],
        format!(".whiphand/wt/{}", wt_suffix(&id))
    );
    assert_eq!(start["worktree"]["branch"], format!("whiphand/{id}"));
    assert_eq!(start["worktree"]["base"], "HEAD");
}

#[test]
fn run_workdir_is_the_workspace_without_a_worktree() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(
        &e,
        "",
        "echo \"$WHIPHAND_WORKDIR\" > \"$WHIPHAND_RUN_DIR/wd.txt\"",
    );
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    assert_eq!(
        canonical(Path::new(&recorded(&e.only_run(), "wd.txt"))),
        canonical(e.ws())
    );
}

// ------------------------------------------------------------------ worktree remove / retention

const LEAVE_UNTRACKED_FILE: &str = "echo wip > scratch.txt";

fn branch_listed(e: &Env, branch: &str) -> bool {
    !git(e.ws(), &["branch", "--list", branch]).trim().is_empty()
}

fn worktree_listed(e: &Env, id: &str) -> bool {
    git(e.ws(), &["worktree", "list", "--porcelain"]).contains(&format!("wt/{}", wt_suffix(id)))
}

fn run_ids(e: &Env) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(e.runs_dir())
        .unwrap()
        .flatten()
        .map(|d| d.file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort();
    ids
}

#[test]
fn worktree_remove_deletes_the_tree_and_keeps_the_branch() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "worktree: true\n", "true");
    assert_eq!(e.run(&["run", "wt"]).code(), 0);
    let id = run_id(&e.only_run());
    let tree = e.ws().join(".whiphand/wt").join(wt_suffix(&id));
    assert!(tree.is_dir());

    let out = e.run(&["worktree", "remove", &id]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(
        out.stdout()
            .contains(&format!("; branch whiphand/{id} kept")),
        "{}",
        out.stdout()
    );
    assert!(!tree.exists());
    assert!(!worktree_listed(&e, &id));
    assert!(branch_listed(&e, &format!("whiphand/{id}")));
    // The run stays, still recording its worktree.
    assert!(e.only_run().join("run.json").is_file());
}

#[test]
fn worktree_remove_refuses_a_dirty_tree_until_forced() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "worktree: true\n", LEAVE_UNTRACKED_FILE);
    assert_eq!(e.run(&["run", "wt"]).code(), 0);
    let id = run_id(&e.only_run());
    let tree = e.ws().join(".whiphand/wt").join(wt_suffix(&id));
    assert!(tree.join("scratch.txt").is_file());

    let out = e.run(&["worktree", "remove", &id]);
    assert_eq!(out.code(), 1, "{}", out.stdout());
    assert!(out.stderr().contains("--force"), "{}", out.stderr());
    assert!(tree.is_dir());

    let out = e.run(&["worktree", "remove", &id, "--force"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(!tree.exists());
    assert!(branch_listed(&e, &format!("whiphand/{id}")));
}

#[test]
fn worktree_remove_names_the_other_runs_that_shared_the_tree() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "worktree: true\n", "true");
    assert_eq!(e.run(&["run", "wt"]).code(), 0);
    let dir = e.only_run();
    let id = run_id(&dir);
    // A second run recording the same worktree.
    let other = "20260101-000000-beef";
    let other_dir = dir.parent().unwrap().join(other);
    std::fs::create_dir_all(&other_dir).unwrap();
    let mut manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("run.json")).unwrap()).unwrap();
    manifest["runId"] = other.into();
    let manifest = manifest.to_string();
    std::fs::write(other_dir.join("run.json"), manifest).unwrap();

    let out = e.run(&["worktree", "remove", &id]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(
        out.stdout().contains(&format!(
            "also used by run(s) {other}; they can no longer be resumed"
        )),
        "{}",
        out.stdout()
    );
    assert!(!e.ws().join(".whiphand/wt").join(wt_suffix(&id)).exists());
}

#[test]
fn worktree_remove_refuses_while_another_run_is_running_in_the_tree() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "worktree: true\n", "true");
    assert_eq!(e.run(&["run", "wt"]).code(), 0);
    let dir = e.only_run();
    let id = run_id(&dir);
    // A second run continued in the same worktree, still going: a live pid keeps it `running`.
    let other = "20990101-000000-beef";
    let other_dir = dir.parent().unwrap().join(other);
    std::fs::create_dir_all(&other_dir).unwrap();
    let mut manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("run.json")).unwrap()).unwrap();
    manifest["runId"] = other.into();
    manifest["status"] = "running".into();
    manifest["pid"] = std::process::id().into();
    std::fs::write(other_dir.join("run.json"), manifest.to_string()).unwrap();

    let out = e.run(&["worktree", "remove", &id]);
    assert_eq!(out.code(), 1, "{}", out.stdout());
    assert!(
        out.stderr()
            .contains(&format!("is in use by run '{other}'")),
        "{}",
        out.stderr()
    );
    assert!(e.ws().join(".whiphand/wt").join(wt_suffix(&id)).is_dir());
}

#[test]
fn worktree_remove_refuses_a_run_without_a_worktree() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "", "true");
    assert_eq!(e.run(&["run", "wt"]).code(), 0);
    let id = run_id(&e.only_run());
    let out = e.run(&["worktree", "remove", &id]);
    assert_eq!(out.code(), 1);
    assert!(
        out.stderr()
            .contains(&format!("run '{id}' has no worktree")),
        "{}",
        out.stderr()
    );
}

#[test]
fn worktree_remove_help_documents_force_and_the_kept_branch() {
    let e = Env::new();
    let out = Out(e
        .command(&["worktree", "remove", "--help"], e.ws())
        .output()
        .unwrap());
    assert_eq!(out.code(), 0);
    assert!(out.stdout().contains("--force"), "{}", out.stdout());
    assert!(out.stdout().contains("branch is kept"), "{}", out.stdout());
}

#[test]
fn pruning_removes_the_oldest_runs_worktree_and_keeps_its_branch() {
    let e = Env::new();
    git_workspace(&e);
    e.write(
        ".whiphand/config.yaml",
        "runs:\n  auto_name: false\n  max_retained: 1\n",
    );
    worktree_workflow(&e, "worktree: true\n", "true");
    assert_eq!(e.run(&["run", "wt"]).code(), 0);
    let first = run_id(&e.only_run());
    // Run ids are second-resolution timestamps plus a suffix; make the second sort later.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    assert_eq!(e.run(&["run", "wt"]).code(), 0);

    let ids = run_ids(&e);
    assert_eq!(ids.len(), 1, "{ids:?}");
    assert_ne!(ids[0], first);
    assert!(!e.ws().join(".whiphand/wt").join(wt_suffix(&first)).exists());
    assert!(!worktree_listed(&e, &first));
    assert!(branch_listed(&e, &format!("whiphand/{first}")));
    assert!(
        e.ws()
            .join(".whiphand/wt")
            .join(wt_suffix(&ids[0]))
            .is_dir()
    );
}

#[test]
fn pruning_keeps_a_dirty_worktree_run_and_says_so() {
    let e = Env::new();
    git_workspace(&e);
    e.write(
        ".whiphand/config.yaml",
        "runs:\n  auto_name: false\n  max_retained: 1\n",
    );
    worktree_workflow(&e, "worktree: true\n", LEAVE_UNTRACKED_FILE);
    assert_eq!(e.run(&["run", "wt"]).code(), 0);
    let first = run_id(&e.only_run());
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let out = e.run(&["run", "wt", "--json"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());

    assert!(e.runs_dir().join(&first).is_dir());
    assert!(
        e.ws()
            .join(".whiphand/wt")
            .join(wt_suffix(&first))
            .join("scratch.txt")
            .is_file()
    );
    let degraded = out
        .stdout()
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find(|v| v["type"] == "run:degraded" && v["capability"] == "retention")
        .unwrap_or_else(|| panic!("no retention event: {}", out.stdout()));
    let reason = degraded["reason"].as_str().unwrap();
    assert!(
        reason.contains(&first) && reason.contains("worktree") && reason.contains("not removed"),
        "{reason}"
    );
}

// ------------------------------------------------------------------ run: --in-worktree

fn run_dirs(e: &Env) -> Vec<PathBuf> {
    let mut runs: Vec<PathBuf> = std::fs::read_dir(e.runs_dir())
        .map(|dir| dir.flatten().map(|d| d.path()).collect())
        .unwrap_or_default();
    runs.sort();
    runs
}

#[test]
fn in_worktree_runs_in_the_earlier_runs_worktree_and_says_so() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "worktree: true\n", RECORD_BRANCH_AND_PWD);
    let out = e.run(&["run", "wt"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let first = run_id(&e.only_run());

    let out = e.run(&["run", "wt", "--in-worktree", &first]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let runs = run_dirs(&e);
    assert_eq!(runs.len(), 2);
    let second = runs.iter().find(|r| run_id(r) != first).unwrap();
    assert_eq!(recorded(second, "branch.txt"), format!("whiphand/{first}"));
    assert_eq!(
        canonical(Path::new(&recorded(second, "pwd.txt"))),
        canonical(&e.ws().join(".whiphand/wt").join(wt_suffix(&first)))
    );
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(second.join("run.json")).unwrap()).unwrap();
    assert_eq!(manifest["worktree"]["continuedFrom"], first.as_str());
    assert!(
        out.stdout().contains(&format!(
            "in worktree of run {first}, branch whiphand/{first}"
        )),
        "{}",
        out.stdout()
    );
    assert!(!out.stdout().contains("🌿 worktree"), "{}", out.stdout());
}

#[test]
fn in_worktree_conflicts_with_the_other_worktree_flags_and_makes_no_run() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "", RECORD_BRANCH_AND_PWD);
    for other in [
        &["--worktree"][..],
        &["--no-worktree"],
        &["--resume", RUN_ID],
    ] {
        let mut args = vec!["run", "wt", "--in-worktree", "x"];
        args.extend_from_slice(other);
        let out = e.run(&args);
        assert_ne!(out.code(), 0, "{args:?}");
        assert!(out.stderr().contains("--in-worktree"), "{}", out.stderr());
    }
    assert!(run_dirs(&e).is_empty());
}

#[test]
fn in_worktree_refusal_is_a_cross_line_and_creates_no_run() {
    let e = Env::new();
    git_workspace(&e);
    worktree_workflow(&e, "", RECORD_BRANCH_AND_PWD);
    let out = e.run(&["run", "wt", "--no-worktree"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let plain = run_id(&e.only_run());

    let out = e.run(&["run", "wt", "--in-worktree", &plain]);
    assert_eq!(out.code(), 1, "{}", out.stdout());
    assert!(
        out.stderr()
            .contains(&format!("✘ run '{plain}' has no worktree")),
        "{}",
        out.stderr()
    );
    let out = e.run(&["run", "wt", "--in-worktree", "no-such-run"]);
    assert_eq!(out.code(), 1);
    assert!(
        out.stderr().contains("✘ no run 'no-such-run'"),
        "{}",
        out.stderr()
    );
    assert_eq!(run_dirs(&e).len(), 1);
}

// ------------------------------------------------------------------ validate

impl Env {
    /// `whiphand validate - -C <workspace>` with `text` on stdin.
    fn validate_stdin(&self, text: &str) -> Out {
        use std::io::Write;
        let ws = self.ws().to_string_lossy().into_owned();
        let mut child = self
            .command(&["validate", "-", "-C", &ws], self.ws())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(text.as_bytes())
            .unwrap();
        Out(child.wait_with_output().unwrap())
    }
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn validate_accepts_the_cycle_example() {
    let e = Env::new();
    let path = repo_root().join("examples/cycle.yaml");
    let out = e.run(&["validate", &path.to_string_lossy()]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    assert_eq!(out.stdout().lines().last(), Some("ok: cycle"));
}

#[test]
fn validate_accepts_every_shipped_template() {
    let e = Env::new();
    let dir = repo_root().join("crates/whiphand-core/templates");
    let mut seen = 0;
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "yaml") {
            continue;
        }
        seen += 1;
        let out = e.run(&["validate", &path.to_string_lossy()]);
        assert_eq!(out.code(), 0, "{}: {}", path.display(), out.stdout());
        assert!(
            !out.stdout().contains("error:"),
            "{}: {}",
            path.display(),
            out.stdout()
        );
        assert!(out.stdout().lines().last().unwrap().starts_with("ok: "));
    }
    assert!(seen > 0, "no templates in {}", dir.display());
}

#[test]
fn validate_prints_each_semantic_problem_and_exits_1() {
    let e = Env::new();
    e.write(
        "broken.yaml",
        "name: broken\nsteps:\n  - id: a\n    kind: command\n    run: echo a\n  - id: a\n    kind: command\n    run: echo b\n  - id: l\n    kind: loop\n    until: nowhere\n    steps:\n      - id: b\n        kind: command\n        run: echo b\n",
    );
    let out = e.run(&["validate", "broken.yaml"]);
    assert_eq!(out.code(), 1, "{}", out.stdout());
    let stdout = out.stdout();
    let lines: Vec<&str> = stdout.lines().collect();
    let errors: Vec<&&str> = lines.iter().filter(|l| l.starts_with("error: ")).collect();
    assert!(
        errors.iter().any(|l| l.contains("duplicate step id 'a'")),
        "{lines:?}"
    );
    assert!(
        errors
            .iter()
            .any(|l| l.contains("until 'nowhere' is not a step in its body")),
        "{lines:?}"
    );
    assert_eq!(
        lines.last().copied(),
        Some(format!("{} problems", errors.len()).as_str())
    );
}

#[test]
fn validate_prints_a_schema_error_and_exits_1() {
    let e = Env::new();
    e.write(
        "shape.yaml",
        "name: shape\nsteps:\n  - id: a\n    kind: command\n    run: echo a\n    timeout_ms: soon\n",
    );
    let out = e.run(&["validate", "shape.yaml"]);
    assert_eq!(out.code(), 1, "{}", out.stdout());
    let stdout = out.stdout();
    assert!(
        stdout
            .lines()
            .any(|l| l.starts_with("error: ") && l.contains("step 'a': Timeout (ms)")),
        "{stdout}"
    );
    assert_eq!(stdout.lines().last(), Some("1 problem"));
}

#[test]
fn validate_reports_a_yaml_syntax_error_as_a_problem() {
    let e = Env::new();
    let out = e.validate_stdin("name: [unclosed\n");
    assert_eq!(out.code(), 1, "{}{}", out.stdout(), out.stderr());
    assert!(
        out.stdout().starts_with("error: YAML parse error: "),
        "{}",
        out.stdout()
    );
    assert_eq!(out.stdout().lines().last(), Some("1 problem"));
}

#[test]
fn validate_reads_stdin() {
    let e = Env::new();
    let out = e.validate_stdin("name: x\nsteps:\n  - id: a\n    kind: command\n    run: echo a\n");
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    assert_eq!(out.stdout(), "ok: x\n");
    let out = e.validate_stdin("name: x\nsteps: []\n");
    assert_eq!(out.code(), 1, "{}", out.stdout());
}

#[test]
fn validate_warnings_alone_do_not_fail() {
    let e = Env::new();
    let out = e.validate_stdin(
        "name: x\nsteps:\n  - id: sign\n    kind: approval\n    title: \"Ship it?\"\n    instructions: \"Look.\"\n    capture: review\n    output: feedback.md\n",
    );
    assert_eq!(out.code(), 0, "{}", out.stdout());
    assert!(
        out.stdout()
            .lines()
            .any(|l| l.starts_with("warning: ") && l.contains("outside a loop")),
        "{}",
        out.stdout()
    );
    assert_eq!(out.stdout().lines().last(), Some("ok: x"));
}

#[test]
fn validate_resolves_a_workflow_by_name() {
    let e = Env::new();
    let init = e.run(&["init", "--storage", "local", "--workflows", "global"]);
    assert_eq!(init.code(), 0, "{}", init.stderr());
    let out = e.run(&["validate", "iterate"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    assert_eq!(out.stdout().lines().last(), Some("ok: iterate"));
    let out = e.run(&["validate", "global:iterate"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
}

#[test]
fn validate_a_missing_file_is_a_usage_error() {
    let e = Env::new();
    let out = e.run(&["validate", "missing/nope.yaml"]);
    assert_eq!(out.code(), 2, "{}{}", out.stdout(), out.stderr());
    assert!(out.stdout().is_empty(), "{}", out.stdout());
    assert!(out.stderr().contains("not found"), "{}", out.stderr());
    let out = e.run(&["validate", "nope"]);
    assert_eq!(out.code(), 2);
    assert!(
        out.stderr().contains("'nope' not found"),
        "{}",
        out.stderr()
    );
}

// ------------------------------------------------------------ workflow-reference

#[test]
fn workflow_reference_prints_the_compiled_in_reference() {
    let e = Env::new();
    // It takes no `-C`: the reference does not depend on a workspace.
    let out = Out(e.command(&["workflow-reference"], e.ws()).output().unwrap());
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert!(out.stderr().is_empty(), "{}", out.stderr());
    assert_eq!(out.stdout(), whiphand_core::reference::workflow_reference());
    assert!(out.stdout().starts_with("# Whiphand workflow format"));
    assert!(out.stdout().contains("whiphand validate"));
}

// ------------------------------------------------------- author-workflow template

const STOCK_AUTHOR: &str = include_str!("../../whiphand-core/templates/author-workflow.yaml");

#[test]
fn restore_workflows_adds_author_workflow_to_a_workspace_set_up_before_it() {
    let e = Env::new();
    assert_eq!(e.run(&["init"]).code(), 0);
    let file = e.ws().join(".whiphand/workflows/author-workflow.yaml");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), STOCK_AUTHOR);
    // A workspace initialized before the template shipped lacks it.
    std::fs::remove_file(&file).unwrap();
    let out = e.run(&["restore-workflows", "author-workflow"]);
    assert_eq!(out.code(), 0, "{}", out.stderr());
    assert_eq!(
        restore_rows(&out),
        [("author-workflow".into(), "added".into())]
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), STOCK_AUTHOR);
    let out = e.run(&["validate", "author-workflow"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
}

/// The JSON events `run --dry-run --json` printed, one per line.
fn events(out: &Out) -> Vec<serde_json::Value> {
    out.stdout()
        .lines()
        .filter(|l| l.starts_with('{'))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn author_workflow_dry_run_points_the_session_at_the_cli_and_the_draft() {
    let e = Env::new();
    let wf = e.write("author.yaml", STOCK_AUTHOR);
    let wf = wf.to_string_lossy().into_owned();
    let out = e.run(&[
        "run",
        &wf,
        "--dry-run",
        "--json",
        "--input",
        "goal=a test-fix loop",
        "--input",
        "name=demo",
    ]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let events = events(&out);
    let run_id = events[0]["runId"].as_str().unwrap().to_string();
    let spawn = |id: &str| {
        events
            .iter()
            .find(|v| v["type"] == "step:spawn" && v["stepId"] == id)
            .unwrap_or_else(|| panic!("no spawn of {id}"))["spec"]
            .clone()
    };
    let design = spawn("design");
    let bin = design["env"]["WHIPHAND_BIN"].as_str().unwrap().to_string();
    assert!(Path::new(&bin).is_absolute(), "{bin}");
    let prompt = design["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"].as_str().unwrap().ends_with(".design.prompt"))
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        prompt.contains(&format!("\"{bin}\" workflow-reference")),
        "{prompt}"
    );
    assert!(
        prompt.contains(&format!("\"{bin}\" validate \"")),
        "{prompt}"
    );
    let draft = prompt
        .lines()
        .find_map(|l| l.strip_prefix("Keep the draft in exactly one file: "))
        .unwrap();
    assert!(Path::new(draft).is_absolute(), "{draft}");
    assert!(draft.contains(&run_id), "{draft}");
    assert!(draft.ends_with("workflow.yaml"), "{draft}");
    // The commands reach the CLI and the inputs through variables only.
    for id in ["check", "save"] {
        let argv = spawn(id)["argv"].to_string();
        assert!(argv.contains("${WHIPHAND_BIN}"), "{id}: {argv}");
        assert!(!argv.contains("{{"), "{id}: {argv}");
        assert!(!argv.contains(&bin), "{id}: {argv}");
    }
    let save = spawn("save")["argv"].to_string();
    assert!(save.contains(r#"\"${WHIPHAND_INPUT_NAME}\""#), "{save}");
    assert!(save.contains(r#"\"${WHIPHAND_INPUT_SCOPE}\""#), "{save}");
}

/// The author-workflow template with everything before `save` replaced by a
/// command step that writes `draft` where the design session would.
fn author_save_only(e: &Env, draft: &str) -> String {
    let steps = STOCK_AUTHOR.find("\nsteps:\n").unwrap();
    let save = STOCK_AUTHOR.find("\n  - id: save\n").unwrap();
    let text = format!(
        "{}\nsteps:\n  - id: draft\n    kind: command\n    env:\n      DRAFT: {draft:?}\n    \
         run: printf '%s' \"$DRAFT\" > \"$WHIPHAND_RUN_DIR/workflow.yaml\"\n{}",
        &STOCK_AUTHOR[..steps],
        &STOCK_AUTHOR[save..],
    );
    e.write("save-only.yaml", &text)
        .to_string_lossy()
        .into_owned()
}

const DRAFT: &str = "name: draft\nsteps:\n  - id: a\n    kind: command\n    run: echo a\n";

#[test]
fn author_workflow_save_refuses_an_unknown_scope_and_writes_nothing() {
    let e = Env::new();
    let wf = author_save_only(&e, DRAFT);
    let out = e.run(&[
        "run",
        &wf,
        "--input",
        "goal=x",
        "--input",
        "name=demo",
        "--input",
        "scope=team",
    ]);
    assert_ne!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let log = std::fs::read_to_string(e.only_run().join("save.log")).unwrap();
    assert!(
        log.contains("scope must be one of project, workspace, global (got 'team')"),
        "{log}"
    );
    assert!(!e.ws().join(".whiphand/workflows").exists());
    assert!(!e.home.path().join("workflows").exists());
}

#[test]
fn author_workflow_save_writes_the_draft_under_the_name_in_the_scope() {
    let e = Env::new();
    let wf = author_save_only(&e, DRAFT);
    let out = e.run(&["run", &wf, "--input", "goal=x", "--input", "name=demo"]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    let saved = e.ws().join(".whiphand/workflows/demo.yaml");
    assert_eq!(
        std::fs::read_to_string(&saved).unwrap(),
        DRAFT.replace("name: draft", "name: demo")
    );
    let log = std::fs::read_to_string(e.only_run().join("save.log")).unwrap();
    assert!(log.contains("demo.yaml"), "{log}");

    let e = Env::new();
    let wf = author_save_only(&e, DRAFT);
    let out = e.run(&[
        "run",
        &wf,
        "--input",
        "goal=x",
        "--input",
        "name=demo",
        "--input",
        "scope=global",
    ]);
    assert_eq!(out.code(), 0, "{}{}", out.stdout(), out.stderr());
    assert!(e.home.path().join("workflows/demo.yaml").is_file());
    assert!(!e.ws().join(".whiphand/workflows").exists());
}
