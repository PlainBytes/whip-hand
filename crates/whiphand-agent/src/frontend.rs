//! The engine's view of the agent (`frontend.ts`, `spawn.ts`): events become
//! notifications, headless spawns stream lines as `stepLog`, interactive
//! steps run in a terminal the clients watch, and manual steps park the run
//! until a client answers.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, MissedTickBehavior};
use tokio_util::sync::CancellationToken;
use whiphand_core::engine::frontend::{EventSink, Frontend, LocalFuture};
use whiphand_core::engine::manual::ManualResponse;
use whiphand_core::engine::spec;
use whiphand_core::engine::step_files::{AwaitReason, parse_await_state};
use whiphand_core::jsval::{self, JsObject, JsValue, ObjExt};
use whiphand_core::obj;
use whiphand_core::process::container::Container;
use whiphand_core::process::launch::{
    ChildStream, LineSink, Out, PipeOptions, SpawnOptions, StdinFrom, errno_name_of, pipe_child,
    route_headless, spawn_runner,
};

use crate::bel::BelScanner;
use crate::host::Agent;
use crate::jobs::{EndReason, Job, LiveSession, PendingManual, SessionControl, abandon_manual};
use crate::pty::{PtyCommand, Signal, Utf8Stream};

/// The exit code an aborted spawn settles with: the CLI's.
pub const ABORTED_EXIT_CODE: i32 = 130;

/// What the human sees when whiphand closes the session for them.
const CLOSING_BANNER: &str =
    "\r\n\x1b[2m[whiphand] step complete \u{2014} closing this session\u{2026}\x1b[0m\r\n";

/// How long a finished session's last output may take to drain.
const OUTPUT_DRAIN: Duration = Duration::from_millis(500);

/// The session's clocks; tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct SessionTimings {
    /// How often a session checks for its end marker and await state. Polled
    /// rather than watched: neither file exists yet, and directory watching
    /// is least dependable exactly where run directories live.
    pub poll: Duration,
    /// How long the runner gets to quit on its own before SIGTERM. Generous:
    /// claude and copilot save the session a resume needs as they shut down.
    pub quit_grace: Duration,
    /// How long it then gets before SIGKILL.
    pub term_grace: Duration,
}

impl Default for SessionTimings {
    fn default() -> Self {
        Self {
            poll: Duration::from_secs(1),
            quit_grace: Duration::from_secs(5),
            term_grace: Duration::from_secs(5),
        }
    }
}

pub struct AgentFrontend {
    pub agent: Rc<Agent>,
    pub job: Rc<Job>,
    pub container: Option<Rc<Container>>,
    /// The last `step:start`: what a terminal is labeled with.
    last_step_id: RefCell<Option<String>>,
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn spawn_error(argv: &[String], e: &std::io::Error) -> String {
    format!(
        "spawn {} {}",
        argv.first().map_or("", String::as_str),
        errno_name_of(e)
    )
}

impl AgentFrontend {
    pub fn new(agent: Rc<Agent>, job: Rc<Job>, container: Option<Rc<Container>>) -> Self {
        Self {
            agent,
            job,
            container,
            last_step_id: RefCell::new(None),
        }
    }

    fn params(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("jobId".into(), json!(self.job.job_id));
        m
    }

    fn kill_tree(&self) {
        if let Some(c) = self.container.clone() {
            tokio::task::spawn_local(async move { c.kill_all().await });
        }
    }
}

impl Frontend for AgentFrontend {
    fn on_event(&self, event: &JsObject, seq: u64, ts: &str) {
        let ty = event
            .get("type")
            .and_then(JsValue::as_str)
            .unwrap_or_default();
        // A resume emits run:resume in place of run:start; both name the run,
        // and the job keeps that name for clients that attach later.
        let starts = ty == "run:start" || ty == "run:resume";
        if starts {
            *self.job.run_id.borrow_mut() = event
                .get("runId")
                .and_then(JsValue::as_str)
                .map(str::to_string);
            *self.job.run_name.borrow_mut() = event
                .get("name")
                .and_then(JsValue::as_str)
                .map(str::to_string);
        }
        if ty == "step:start" {
            *self.last_step_id.borrow_mut() = event
                .get("stepId")
                .and_then(JsValue::as_str)
                .map(str::to_string);
        }
        let mut p = self.params();
        self.job.tag(&mut p);
        self.job.tag_run(&mut p);
        p.insert("event".into(), jsval::to_json(&JsValue::Obj(event.clone())));
        p.insert("ts".into(), json!(ts));
        p.insert("seq".into(), json!(seq));
        self.agent.notify("whiphandEvent", Value::Object(p));
        if starts {
            let mut p = self.params();
            self.job.tag(&mut p);
            self.job.tag_run(&mut p);
            p.insert("status".into(), json!("running"));
            self.agent.notify("runStateChanged", Value::Object(p));
        }
    }

    fn spawn_headless<'a>(
        &'a self,
        spec_obj: &'a JsObject,
        cancel: CancellationToken,
        mut on_line: Option<LineSink<'a>>,
    ) -> LocalFuture<'a, Result<i32, String>> {
        Box::pin(async move {
            let argv = spec::argv(spec_obj);
            let capture = spec::capture(spec_obj);
            let route = route_headless(
                spec::progress_format(spec_obj).is_some(),
                capture.as_ref().map(|(p, s)| (p.as_str(), s.as_deref())),
                on_line.is_some(),
            );
            let opts = SpawnOptions {
                cwd: Some(spec::cwd(spec_obj).into()),
                env: spec::env(spec_obj),
                stdin: spec::stdin_file(spec_obj)
                    .map_or(StdinFrom::Null, |f| StdinFrom::File(f.into())),
                stdout: Out::Piped,
                stderr: Out::Piped,
            };
            let child = spawn_runner(&argv, opts, self.container.as_deref(), true)
                .map_err(|e| spawn_error(&argv, &e))?;
            let progress = route.progress;
            let agent = self.agent.clone();
            let job_id = self.job.job_id.clone();
            // A progress spec's stdout is structured output for core, not
            // prose; every other line is logged and handed on.
            let sink: LineSink<'_> = Box::new(move |line: &str, stream: ChildStream| {
                let stream_name = match stream {
                    ChildStream::Stdout => "stdout",
                    ChildStream::Stderr => "stderr",
                };
                if !(progress && stream == ChildStream::Stdout) {
                    agent.notify(
                        "stepLog",
                        json!({ "jobId": job_id, "stream": stream_name, "line": line }),
                    );
                }
                if let Some(f) = on_line.as_mut() {
                    f(line, stream);
                }
            });
            let code = pipe_child(
                child,
                PipeOptions {
                    on_chunk: None,
                    on_line: Some(sink),
                    capture: route.capture.map(|(p, s)| (p.into(), s)),
                    cancel: Some(cancel.clone()),
                    abort_exit_code: Some(ABORTED_EXIT_CODE),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            if cancel.is_cancelled()
                && let Some(c) = &self.container
            {
                c.kill_all().await;
            }
            Ok(code)
        })
    }

    fn run_interactive<'a>(
        &'a self,
        spec_obj: &'a JsObject,
        cancel: CancellationToken,
        emit: EventSink<'a>,
    ) -> LocalFuture<'a, Result<i32, String>> {
        Box::pin(self.interactive(spec_obj, cancel, emit))
    }

    fn can_run_manual(&self) -> bool {
        true
    }

    /// Parks the run and hands the question to the clients. Nothing times
    /// out: a human gate waits as long as the human does, and cancellation
    /// is the only other way out.
    fn run_manual<'a>(
        &'a self,
        request: &'a JsObject,
        cancel: CancellationToken,
    ) -> LocalFuture<'a, Result<ManualResponse, String>> {
        Box::pin(async move {
            let job = &self.job;
            if let Some(p) = job.pending_manual.borrow().as_ref() {
                return Err(format!(
                    "job '{}' is already waiting on step '{}'",
                    job.job_id, p.step_id
                ));
            }
            if cancel.is_cancelled() {
                return Err("run cancelled".into());
            }
            let request_json = jsval::to_json(&JsValue::Obj(request.clone()));
            let step_id = request_json["stepId"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let (tx, rx) = oneshot::channel();
            *job.pending_manual.borrow_mut() = Some(PendingManual {
                request: request_json.clone(),
                step_id: step_id.clone(),
                answer: tx,
            });
            let mut p = self.params();
            self.job.tag_run(&mut p);
            p.insert("request".into(), request_json);
            self.agent.notify("manualRequest", Value::Object(p));

            let outcome = tokio::select! {
                answer = rx => answer.unwrap_or_else(|_| Err("run ended".into())),
                () = cancel.cancelled() => {
                    abandon_manual(job, "run cancelled");
                    Err("run cancelled".into())
                }
            };
            let mut resolved = self.params();
            resolved.insert("stepId".into(), json!(step_id));
            if let Ok(r) = &outcome {
                resolved.insert("choice".into(), json!(r.choice));
            }
            self.agent.notify("manualResolved", Value::Object(resolved));
            outcome
        })
    }
}

/// How the session's close was asked for.
fn ended_via(ending: Option<EndReason>) -> &'static str {
    match ending {
        Some(EndReason::Marker) => "marker",
        Some(EndReason::User) => "quit",
        None => "exit",
    }
}

impl AgentFrontend {
    async fn interactive(
        &self,
        spec_obj: &JsObject,
        cancel: CancellationToken,
        mut emit: EventSink<'_>,
    ) -> Result<i32, String> {
        let job = &self.job;
        if job.session.borrow().is_some() {
            return Err(format!(
                "job '{}' already has a live PTY (only one interactive step runs at a time)",
                job.job_id
            ));
        }
        // The on_findings 'interactive' triage opens a session with no
        // step:start before it.
        let step_id = self
            .last_step_id
            .borrow()
            .clone()
            .unwrap_or_else(|| "triage".into());
        let (cols, rows) = (job.pty_cols.get(), job.pty_rows.get());
        let argv = spec::argv(spec_obj);
        let env = spec::env(spec_obj);
        let cwd = spec::cwd(spec_obj);
        let spawned = crate::pty::spawn(&PtyCommand {
            argv: &argv,
            cwd: &cwd,
            env: &env,
            cols,
            rows,
        })?;
        let process = Rc::new(spawned.process);
        // A terminal's child leads its own session, and so its own group.
        if let Some(c) = &self.container {
            c.adopt(process.pid(), cfg!(unix));
        }
        let mut output = spawned.output;
        let mut exit = spawned.exit;

        let end_session = spec_obj
            .get("endSession")
            .and_then(JsValue::as_obj)
            .cloned();
        let marker = end_session
            .as_ref()
            .and_then(|e| e.get("markerPath"))
            .and_then(JsValue::as_str)
            .map(str::to_string);
        let quit_sequence = end_session
            .as_ref()
            .and_then(|e| e.get("quitSequence"))
            .and_then(JsValue::as_str)
            .unwrap_or_default()
            .to_string();
        let await_path = spec_obj
            .get("awaitState")
            .and_then(JsValue::as_obj)
            .and_then(|a| a.get("statePath"))
            .and_then(JsValue::as_str)
            .map(str::to_string);

        let (control_tx, mut control) = mpsc::unbounded_channel();
        *job.session.borrow_mut() = Some(LiveSession {
            process: process.clone(),
            control: control_tx,
            endable: end_session.is_some(),
        });

        let notify = |method: &str, extra: Value| {
            let mut p = self.params();
            if let Value::Object(m) = extra {
                p.extend(m);
            }
            self.agent.notify(method, Value::Object(p));
        };
        notify(
            "ptyStarted",
            json!({ "stepId": step_id, "cols": cols, "rows": rows }),
        );

        let timings = self.agent.timings;
        let mut poll = tokio::time::interval(timings.poll);
        poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
        poll.tick().await;

        // Hooks (the await-state file) beat the bell in both directions; a
        // bell must never downgrade a state actually known.
        // Every report sets the bell state right before it, so the latch
        // lives in each call rather than in a variable.
        let mut hook: Option<AwaitReason> = None;
        let mut reported: Option<AwaitReason> = None;
        let mut publish = |hook: Option<AwaitReason>, bell: bool, emit: &mut EventSink<'_>| {
            let next = hook.or(bell.then_some(AwaitReason::Attention));
            if next == reported {
                return;
            }
            reported = next;
            let mut p = json!({ "stepId": step_id, "awaiting": next.is_some() });
            let mut event = obj! { "type" => "session:await", "stepId" => step_id.as_str(), "awaiting" => next.is_some() };
            if let Some(r) = next {
                p["reason"] = json!(r.as_str());
                event.set("reason", r.as_str());
            }
            notify("ptyAwait", p);
            emit(event);
        };

        let mut utf8 = Utf8Stream::default();
        let mut bells = BelScanner::default();
        let mut watching_marker = marker.is_some();
        let mut ending: Option<EndReason> = None;
        let mut end_stage: Option<(Instant, Signal)> = None;
        let mut cancel_seen = false;
        let mut exited: Option<i32> = None;
        let mut output_open = true;
        let mut drain_deadline: Option<Instant> = None;
        let mut marker_error_at: Option<Instant> = None;

        let forward = |text: String, bells: &mut BelScanner| -> bool {
            if text.is_empty() {
                return false;
            }
            let rang = bells.scan(&text) > 0;
            notify("ptyData", json!({ "data": b64(text.as_bytes()) }));
            rang
        };

        loop {
            if exited.is_some()
                && (!output_open || drain_deadline.is_some_and(|d| Instant::now() >= d))
            {
                break;
            }
            let stage_at = end_stage.map(|(at, _)| at);
            tokio::select! {
                chunk = output.recv(), if output_open => match chunk {
                    Some(bytes) => {
                        if forward(utf8.push(&bytes), &mut bells) {
                            publish(hook, true, &mut emit);
                        }
                    }
                    None => output_open = false,
                },
                code = &mut exit, if exited.is_none() => {
                    exited = Some(code.unwrap_or(1));
                    drain_deadline = Some(Instant::now() + OUTPUT_DRAIN);
                }
                Some(msg) = control.recv() => match msg {
                    SessionControl::ClearBell => {
                        publish(hook, false, &mut emit);
                    }
                    SessionControl::End(reason) => {
                        if ending.is_none() && end_session.is_some() && exited.is_none() {
                            ending = Some(reason);
                            watching_marker = false;
                            // We can only write to the child's input, never
                            // paint its screen: say so where its output goes.
                            notify("ptyData", json!({ "data": b64(CLOSING_BANNER.as_bytes()) }));
                            if !quit_sequence.is_empty() {
                                process.write(quit_sequence.as_bytes());
                            }
                            let first = if quit_sequence.is_empty() { Duration::ZERO } else { timings.quit_grace };
                            end_stage = Some((Instant::now() + first, Signal::Term));
                        }
                    }
                },
                () = tokio::time::sleep_until(stage_at.unwrap_or_else(Instant::now)), if stage_at.is_some() && exited.is_none() => {
                    let (_, signal) = end_stage.take().expect("a pending stage");
                    process.kill(signal);
                    if signal == Signal::Term {
                        end_stage = Some((Instant::now() + timings.term_grace, Signal::Kill));
                    }
                }
                _ = poll.tick(), if exited.is_none() && (watching_marker || await_path.is_some()) => {
                    if watching_marker && let Some(path) = &marker {
                        match std::fs::metadata(path) {
                            Ok(_) => {
                                watching_marker = false;
                                let _ = job.session.borrow().as_ref().map(|s| s.control.send(SessionControl::End(EndReason::Marker)));
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                            Err(e) => {
                                if marker_error_at.is_none_or(|t| t.elapsed() > Duration::from_secs(30)) {
                                    eprintln!("[watchForMarker] Cannot stat {path}: {e}");
                                    marker_error_at = Some(Instant::now());
                                }
                            }
                        }
                    }
                    if let Some(path) = &await_path {
                        let next = match std::fs::read(path) {
                            Ok(bytes) => parse_await_state(&String::from_utf8_lossy(&bytes)).map(Some),
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(None),
                            Err(_) => None,
                        };
                        // Only a change says anything; garbage says nothing.
                        if let Some(next) = next && next != hook {
                            hook = next;
                            publish(hook, false, &mut emit);
                        }
                    }
                }
                () = cancel.cancelled(), if !cancel_seen && exited.is_none() => {
                    cancel_seen = true;
                    process.kill(Signal::Hup);
                    self.kill_tree();
                }
            }
        }

        forward(utf8.finish(), &mut bells);
        *job.session.borrow_mut() = None;
        // A deliberate end is success: the runner was stopped on our say-so.
        let code = exited.unwrap_or(1);
        let reported_code = if ending.is_some() { 0 } else { code };
        let reason = if ending.is_some() { "ended" } else { "exit" };
        notify(
            "ptyExit",
            json!({ "exitCode": reported_code, "reason": reason }),
        );
        emit(obj! {
            "type" => "step:pty-exit", "stepId" => step_id.as_str(),
            "exitCode" => f64::from(reported_code), "reason" => reason,
        });
        emit(
            obj! { "type" => "session:ended", "stepId" => step_id.as_str(), "via" => ended_via(ending) },
        );
        Ok(reported_code)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;
    use whiphand_core::jsval::{JsValue, from_json};

    use super::*;
    use crate::host::{ClientKind, HostConfig};

    type Lines = Arc<Mutex<Vec<Value>>>;

    fn setup(dir: &std::path::Path) -> (Rc<Agent>, Rc<Job>, Lines) {
        // Nothing reads the inbox here; the remote server's sends just fail.
        let (inbox, _) = tokio::sync::mpsc::unbounded_channel();
        let agent = Agent::new(
            HostConfig {
                app_state_path: dir.join("app-state.json"),
                remote_config_path: dir.join("remote-access.json"),
                web_root: None,
                timings: SessionTimings {
                    poll: Duration::from_millis(20),
                    quit_grace: Duration::from_millis(200),
                    term_grace: Duration::from_millis(200),
                },
            },
            inbox,
            Default::default(),
        );
        let lines: Lines = Arc::default();
        let sink = lines.clone();
        agent.add_client(
            1,
            ClientKind::Desktop,
            Box::new(move |l| sink.lock().unwrap().push(serde_json::from_str(&l).unwrap())),
        );
        let job = agent.jobs.create(dir.to_string_lossy().into_owned(), None);
        (agent, job, lines)
    }

    fn spec(script: &str, extra: Value) -> JsObject {
        let mut v =
            json!({ "argv": ["sh", "-c", script], "cwd": ".", "env": {}, "interactive": true });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        match from_json(&v) {
            JsValue::Obj(o) => o,
            _ => unreachable!(),
        }
    }

    fn of(lines: &Lines, method: &str) -> Vec<Value> {
        lines
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m["method"] == method)
            .map(|m| m["params"].clone())
            .collect()
    }

    fn text(lines: &Lines) -> String {
        of(lines, "ptyData")
            .iter()
            .map(|p| {
                String::from_utf8_lossy(
                    &base64::engine::general_purpose::STANDARD
                        .decode(p["data"].as_str().unwrap())
                        .unwrap(),
                )
                .into_owned()
            })
            .collect()
    }

    async fn run(
        frontend: &AgentFrontend,
        spec: &JsObject,
        cancel: CancellationToken,
    ) -> (i32, Vec<String>) {
        let events = RefCell::new(Vec::new());
        let code = frontend
            .run_interactive(
                spec,
                cancel,
                Box::new(|e| {
                    events
                        .borrow_mut()
                        .push(jsval::stringify_compact(&JsValue::Obj(e)))
                }),
            )
            .await
            .unwrap();
        (code, events.into_inner())
    }

    fn local<F: std::future::Future>(f: F) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        tokio::task::LocalSet::new().block_on(&rt, f)
    }

    #[test]
    fn a_session_streams_output_and_reports_its_exit() {
        let dir = tempfile::tempdir().unwrap();
        local(async {
            let (agent, job, lines) = setup(dir.path());
            let fe = AgentFrontend::new(agent, job.clone(), None);
            let (code, events) = run(
                &fe,
                &spec("printf 'hello \\342\\202\\254'; exit 3", json!({})),
                CancellationToken::new(),
            )
            .await;
            assert_eq!(code, 3);
            assert!(text(&lines).contains("hello €"), "{}", text(&lines));
            assert_eq!(
                of(&lines, "ptyStarted")[0],
                json!({ "jobId": job.job_id, "stepId": "triage", "cols": 80, "rows": 24 })
            );
            assert_eq!(
                of(&lines, "ptyExit")[0],
                json!({ "jobId": job.job_id, "exitCode": 3, "reason": "exit", })
            );
            assert_eq!(
                events,
                [
                    r#"{"type":"step:pty-exit","stepId":"triage","exitCode":3,"reason":"exit"}"#,
                    r#"{"type":"session:ended","stepId":"triage","via":"exit"}"#,
                ]
            );
            assert!(job.session.borrow().is_none());
        });
    }

    #[test]
    fn the_end_marker_closes_the_session_as_success() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("marker");
        local(async {
            let (agent, job, lines) = setup(dir.path());
            let fe = AgentFrontend::new(agent, job.clone(), None);
            let s = spec(
                &format!("touch '{}'; sleep 30", marker.display()),
                json!({ "endSession": { "markerPath": marker.to_string_lossy(), "quitSequence": "" } }),
            );
            let (code, events) = run(&fe, &s, CancellationToken::new()).await;
            assert_eq!(code, 0);
            assert!(text(&lines).contains("closing this session"));
            assert_eq!(of(&lines, "ptyExit")[0]["reason"], "ended");
            assert!(events[1].contains(r#""via":"marker""#), "{events:?}");
        });
    }

    #[test]
    fn a_quit_sequence_is_typed_before_any_signal() {
        let dir = tempfile::tempdir().unwrap();
        local(async {
            let (agent, job, _lines) = setup(dir.path());
            let fe = AgentFrontend::new(agent, job.clone(), None);
            // Exits 7 on reading the quit line; the reported code is still 0.
            let s = spec(
                "read line; [ \"$line\" = bye ] && exit 7; exit 9",
                json!({ "endSession": { "markerPath": "/nonexistent/x", "quitSequence": "bye\r" } }),
            );
            let job2 = job.clone();
            tokio::task::spawn_local(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                let control = job2.session.borrow().as_ref().unwrap().control.clone();
                control.send(SessionControl::End(EndReason::User)).unwrap();
            });
            let (code, events) = run(&fe, &s, CancellationToken::new()).await;
            assert_eq!(code, 0);
            assert!(events[1].contains(r#""via":"quit""#), "{events:?}");
        });
    }

    #[test]
    fn await_state_and_the_bell_report_transitions_only() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("await.json");
        local(async {
            let (agent, job, lines) = setup(dir.path());
            let fe = AgentFrontend::new(agent, job.clone(), None);
            let script = format!(
                "printf '\\a'; sleep 0.3; echo '{{\"r\":\"turn\"}}' > '{s}'; sleep 0.3; rm '{s}'; sleep 0.3",
                s = state.display()
            );
            let (_, events) = run(
                &fe,
                &spec(
                    &script,
                    json!({ "awaitState": { "statePath": state.to_string_lossy() } }),
                ),
                CancellationToken::new(),
            )
            .await;
            let awaits: Vec<(bool, Option<String>)> = of(&lines, "ptyAwait")
                .iter()
                .map(|p| {
                    (
                        p["awaiting"].as_bool().unwrap(),
                        p["reason"].as_str().map(str::to_string),
                    )
                })
                .collect();
            assert_eq!(
                awaits,
                [
                    (true, Some("attention".into())),
                    (true, Some("turn".into())),
                    (false, None),
                ]
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|e| e.contains("session:await"))
                    .count(),
                3
            );
        });
    }

    #[test]
    fn a_cancel_ends_the_session() {
        let dir = tempfile::tempdir().unwrap();
        local(async {
            let (agent, job, _lines) = setup(dir.path());
            let fe = AgentFrontend::new(agent, job.clone(), None);
            let cancel = CancellationToken::new();
            let c = cancel.clone();
            tokio::task::spawn_local(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                c.cancel();
            });
            let started = Instant::now();
            run(&fe, &spec("sleep 30", json!({})), cancel).await;
            assert!(started.elapsed() < Duration::from_secs(5));
        });
    }

    #[test]
    fn a_manual_step_waits_for_its_answer() {
        let dir = tempfile::tempdir().unwrap();
        local(async {
            let (agent, job, lines) = setup(dir.path());
            let fe = AgentFrontend::new(agent, job.clone(), None);
            let request = match from_json(&json!({ "stepId": "gate", "kind": "approval" })) {
                JsValue::Obj(o) => o,
                _ => unreachable!(),
            };
            let job2 = job.clone();
            tokio::task::spawn_local(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                assert!(!crate::jobs::answer_manual(
                    &job2,
                    "other",
                    ManualResponse::default()
                ));
                let answer = ManualResponse {
                    choice: "continue".into(),
                    ..ManualResponse::default()
                };
                assert!(crate::jobs::answer_manual(&job2, "gate", answer));
            });
            let response = fe
                .run_manual(&request, CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(response.choice, "continue");
            assert_eq!(
                of(&lines, "manualResolved")[0],
                json!({ "jobId": job.job_id, "stepId": "gate", "choice": "continue" })
            );
        });
    }
}
