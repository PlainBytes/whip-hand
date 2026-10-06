//! The remote channel over real sockets (`remote/server.test.ts`): a `Host`
//! with remote access enabled, a desktop client on its own channel, and
//! browsers played by a WebSocket client.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use whiphand_agent::frontend::SessionTimings;
use whiphand_agent::{Client, ClientKind, Host, HostConfig};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

struct Harness {
    _dir: tempfile::TempDir,
    host: Option<Host>,
    desktop: Client,
    lines: mpsc::Receiver<Value>,
    port: u16,
    next_id: u64,
}

impl Harness {
    fn start(web_root: Option<&Path>) -> Harness {
        Self::start_on(free_port(), web_root)
    }

    fn start_on(port: u16, web_root: Option<&Path>) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote-access.json");
        std::fs::write(
            &remote,
            json!({ "schemaVersion": 1, "enabled": true, "port": port, "token": TOKEN })
                .to_string(),
        )
        .unwrap();
        let empty = dir.path().join("no-web-root");
        std::fs::create_dir(&empty).unwrap();
        let host = Host::start(HostConfig {
            app_state_path: dir.path().join("app-state.json"),
            remote_config_path: remote,
            web_root: Some(web_root.map_or(empty, Path::to_path_buf)),
            timings: SessionTimings::default(),
        })
        .unwrap();
        let (tx, lines) = mpsc::channel();
        let desktop = host.connect(
            ClientKind::Desktop,
            Box::new(move |l| {
                let _ = tx.send(serde_json::from_str(&l).unwrap());
            }),
        );
        let mut h = Harness {
            _dir: dir,
            host: Some(host),
            desktop,
            lines,
            port,
            next_id: 1000,
        };
        // The startup config applies asynchronously.
        for _ in 0..100 {
            if h.call("remoteAccessGet", json!({}))["result"]["listening"] == true
                || h.call("remoteAccessGet", json!({}))["result"]["error"].is_string()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        h
    }

    /// A desktop call, answered on the desktop's own channel.
    fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.desktop
            .send(json!({ "id": id, "method": method, "params": params }).to_string());
        loop {
            let m = self
                .lines
                .recv_timeout(Duration::from_secs(10))
                .expect("a response");
            if m["id"] == id {
                return m;
            }
        }
    }

    /// The next desktop notification named `method`.
    fn notification(&self, method: &str) -> Value {
        loop {
            let m = self
                .lines
                .recv_timeout(Duration::from_secs(10))
                .expect("a notification");
            if m["method"] == method {
                return m["params"].clone();
            }
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(h) = self.host.take() {
            h.shutdown();
        }
    }
}

async fn connect(
    port: u16,
    token: &str,
    origin: Option<&str>,
) -> Result<(Ws, Option<String>), WsError> {
    let mut req = format!("ws://127.0.0.1:{port}/ws")
        .into_client_request()
        .unwrap();
    let protocols = format!("whiphand, whiphand.token.{token}");
    req.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&protocols).unwrap(),
    );
    if let Some(o) = origin {
        req.headers_mut()
            .insert("Origin", HeaderValue::from_str(o).unwrap());
    }
    let (ws, response) = tokio_tungstenite::connect_async(req).await?;
    let echoed = response
        .headers()
        .get("Sec-WebSocket-Protocol")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    Ok((ws, echoed))
}

fn status_of(e: WsError) -> u16 {
    match e {
        WsError::Http(r) => r.status().as_u16(),
        other => panic!("expected an HTTP refusal, got {other}"),
    }
}

async fn next_json(ws: &mut Ws) -> Option<Value> {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .ok()??
        {
            Ok(Message::Text(t)) => return Some(serde_json::from_str(&t).unwrap()),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

async fn ws_call(ws: &mut Ws, id: u64, method: &str, params: Value) -> Value {
    ws.send(Message::Text(
        json!({ "id": id, "method": method, "params": params })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let m = next_json(ws).await.expect("a response");
        if m["id"] == id {
            return m;
        }
    }
}

/// `GET path` with a raw Host header, for the checks a browser cannot forge.
async fn raw_get(port: u16, path: &str, headers: &[(&str, &str)]) -> (u16, String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut req = format!("GET {path} HTTP/1.1\r\nConnection: close\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    let status = out[9..12].parse().unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap_or((&out, ""));
    (status, head.to_lowercase(), body.to_string())
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn a_valid_token_opens_the_channel_and_echoes_only_the_protocol_name() {
    let mut h = Harness::start(None);
    assert_eq!(
        h.call("remoteAccessGet", json!({}))["result"]["listening"],
        true
    );
    rt().block_on(async {
        let (mut ws, echoed) = connect(h.port, TOKEN, None).await.unwrap();
        assert_eq!(echoed.as_deref(), Some("whiphand"));
        let r = ws_call(&mut ws, 1, "hello", json!({})).await;
        assert_eq!(r["result"]["protocolVersion"], 1);
    });
}

#[test]
fn a_bad_token_is_a_real_401() {
    let h = Harness::start(None);
    rt().block_on(async {
        let e = connect(h.port, "wrong", None).await.unwrap_err();
        assert_eq!(status_of(e), 401);
    });
}

#[test]
fn a_foreign_origin_or_a_rebound_host_is_refused_even_with_the_token() {
    let h = Harness::start(None);
    rt().block_on(async {
        let e = connect(h.port, TOKEN, Some("http://evil.example"))
            .await
            .unwrap_err();
        assert_eq!(status_of(e), 403);
        let (status, _, body) = raw_get(
            h.port,
            "/",
            &[("Host", &format!("evil.example:{}", h.port))],
        )
        .await;
        assert_eq!(status, 403);
        assert!(body.contains("evil.example"), "{body}");
    });
}

#[test]
fn desktop_only_methods_and_path_attachments_are_not_remote() {
    let h = Harness::start(None);
    rt().block_on(async {
        let (mut ws, _) = connect(h.port, TOKEN, None).await.unwrap();
        let r = ws_call(&mut ws, 1, "remoteAccessGet", json!({})).await;
        assert_eq!(r["error"]["code"], -32601);
        let r = ws_call(
            &mut ws,
            2,
            "startRun",
            json!({ "workdir": "/w", "workflow": "f", "attachments": [{ "path": "/etc/passwd" }] }),
        )
        .await;
        assert_eq!(r["error"]["code"], -32602, "{r}");
    });
}

#[test]
fn two_connections_may_both_use_id_1_and_notifications_reach_everyone() {
    let mut h = Harness::start(None);
    rt().block_on(async {
        let (mut a, _) = connect(h.port, TOKEN, None).await.unwrap();
        let (mut b, _) = connect(h.port, TOKEN, None).await.unwrap();
        let ra = ws_call(&mut a, 1, "hello", json!({})).await;
        let rb = ws_call(&mut b, 1, "hello", json!({})).await;
        assert!(ra["result"].is_object() && rb["result"].is_object());
        ws_call(&mut a, 2, "setUiState", json!({ "theme": "dark" })).await;
        let seen = loop {
            let m = next_json(&mut b).await.expect("a notification");
            if m["method"] == "appStateChanged" {
                break m;
            }
        };
        assert_eq!(seen["params"]["theme"], "dark");
    });
    assert_eq!(h.notification("appStateChanged")["theme"], "dark");
    assert!(h.call("hello", json!({}))["result"].is_object());
}

#[test]
fn ping_gates_on_the_token() {
    let h = Harness::start(None);
    rt().block_on(async {
        let host = format!("127.0.0.1:{}", h.port);
        let (status, _, body) = raw_get(h.port, "/api/ping", &[("Host", &host)]).await;
        assert_eq!((status, body.trim()), (401, "{\"error\":\"unauthorized\"}"));
        let bearer = format!("Bearer {TOKEN}");
        let (status, head, body) = raw_get(
            h.port,
            "/api/ping",
            &[("Host", &host), ("Authorization", &bearer)],
        )
        .await;
        assert_eq!((status, body.trim()), (200, "{\"ok\":true}"));
        assert!(head.contains("cache-control: no-store"));
    });
}

#[test]
fn an_unbuilt_ui_is_503_and_a_built_one_is_served_with_its_policy() {
    let h = Harness::start(None);
    rt().block_on(async {
        let host = format!("127.0.0.1:{}", h.port);
        let (status, _, body) = raw_get(h.port, "/", &[("Host", &host)]).await;
        assert_eq!(status, 503);
        assert!(body.contains("npm run build:web"));
    });
    drop(h);

    let web = tempfile::tempdir().unwrap();
    std::fs::write(web.path().join("index.html"), "<!doctype html>").unwrap();
    let h = Harness::start(Some(web.path()));
    rt().block_on(async {
        let host = format!("127.0.0.1:{}", h.port);
        let (status, head, body) = raw_get(h.port, "/runs/abc", &[("Host", &host)]).await;
        assert_eq!((status, body.as_str()), (200, "<!doctype html>"));
        assert!(head.contains("content-security-policy: default-src 'self'"));
        assert!(head.contains("cache-control: no-store"));
        let (status, _, _) = raw_get(h.port, "/assets/missing.js", &[("Host", &host)]).await;
        assert_eq!(status, 404);
    });
}

#[test]
fn rotating_the_token_closes_every_socket_with_4001() {
    let mut h = Harness::start(None);
    rt().block_on(async {
        let (mut ws, _) = connect(h.port, TOKEN, None).await.unwrap();
        ws_call(&mut ws, 1, "hello", json!({})).await;
        let rotated = h.call("remoteAccessRotateToken", json!({}));
        let token = rotated["result"]["token"].as_str().unwrap().to_string();
        assert_ne!(token, TOKEN);
        let code = loop {
            match tokio::time::timeout(Duration::from_secs(10), ws.next())
                .await
                .unwrap()
            {
                Some(Ok(Message::Close(frame))) => break frame.map(|f| f.code),
                Some(Ok(_)) => {}
                other => panic!("expected a close frame, got {other:?}"),
            }
        };
        assert_eq!(code, Some(CloseCode::from(4001)));
        assert_eq!(
            status_of(connect(h.port, TOKEN, None).await.unwrap_err()),
            401
        );
        assert!(connect(h.port, &token, None).await.is_ok());
    });
    let published = h.notification("remoteAccessChanged");
    assert!(published.get("token").is_none(), "{published}");
}

#[test]
fn the_client_count_follows_connections() {
    let mut h = Harness::start(None);
    let count = |h: &mut Harness| {
        h.call("remoteAccessGet", json!({}))["result"]["clientCount"]
            .as_u64()
            .unwrap()
    };
    assert_eq!(count(&mut h), 0);
    let rt = rt();
    let ws = rt.block_on(async { connect(h.port, TOKEN, None).await.unwrap().0 });
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(count(&mut h), 1);
    drop(ws);
    for _ in 0..50 {
        if count(&mut h) == 0 {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("the client count never went back to 0");
}

#[test]
fn a_port_in_use_is_reported_never_thrown() {
    let taken = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let mut h = Harness::start_on(port, None);
    let state = h.call("remoteAccessGet", json!({}))["result"].clone();
    assert_eq!(state["listening"], false);
    assert_eq!(state["error"], format!("Port {port} is already in use"));
    assert!(
        h.call("hello", json!({}))["result"].is_object(),
        "the agent is still up"
    );
}
