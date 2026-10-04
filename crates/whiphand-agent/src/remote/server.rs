//! The HTTP and WebSocket server a browser on the LAN drives the agent
//! through (`remote/server.ts`):
//!   - the built UI on any other path, with no token (see `static_files`);
//!   - `GET /api/ping` with `Authorization: Bearer <token>`, so the web
//!     client can check a token before mounting and show a rescan screen
//!     rather than an endless reconnect;
//!   - `/ws`, the RPC channel, with the token in `Sec-WebSocket-Protocol`.
//!
//! Host and Origin are checked on every request, not only the
//! authenticated ones: reaching the UI by some other hostname would load a
//! page that silently fails to connect, and a 403 naming the reason is
//! easier to act on than a spinner. A refused upgrade is a real HTTP 401
//! rather than a handshake completed and then closed.
//!
//! Each socket becomes a `Remote` client of the host, through the same
//! channel the desktop's lines take, so it gets notifications and its own
//! responses like any client, and only the remote methods.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::auth::{
    FailureThrottle, Origin, PROTOCOL_NAME, check_host_and_origin, local_addresses,
    token_from_protocol_header, token_matches,
};
use super::static_files::{SHELL_CSP, resolve_static};
use crate::host::{ClientKind, Msg};

/// One frame's limit. Keystrokes are tiny; the one large legitimate frame is
/// a `startRun` carrying base64 attachments (roughly 750 KB of files).
const MAX_FRAME_BYTES: usize = 1 << 20;

/// "Your token is no longer valid" (application range); the web client
/// stops reconnecting on it.
pub const CLOSE_TOKEN_REVOKED: u16 = 4001;

/// How a socket is told to go.
enum Close {
    Revoked(String),
    Terminate,
}

struct Shared {
    token: String,
    port: u16,
    throttle: FailureThrottle,
    sockets: HashMap<u64, oneshot::Sender<Close>>,
}

#[derive(Clone)]
struct Ctx {
    shared: Arc<Mutex<Shared>>,
    inbox: mpsc::UnboundedSender<Msg>,
    next_id: Arc<AtomicU64>,
    web_root: Option<PathBuf>,
}

impl Ctx {
    fn lock(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn status_changed(&self) {
        let _ = self.inbox.send(Msg::RemoteStatusChanged);
    }

    fn authorized(&self, ip: &str, provided: Option<&str>) -> bool {
        let mut s = self.lock();
        let now = Instant::now();
        if s.throttle.blocked(ip, now) {
            return false;
        }
        if !token_matches(&s.token, provided) {
            s.throttle.record(ip, now);
            return false;
        }
        s.throttle.clear(ip);
        true
    }
}

pub struct ServerStatus {
    pub listening: bool,
    pub error: Option<String>,
    pub client_count: usize,
}

/// The server's handle, on the engine thread.
pub struct RemoteServer {
    shared: Arc<Mutex<Shared>>,
    inbox: mpsc::UnboundedSender<Msg>,
    next_id: Arc<AtomicU64>,
    running: Option<(CancellationToken, tokio::task::JoinHandle<()>)>,
    error: Option<String>,
}

fn text(status: StatusCode, content_type: &str, body: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, content_type.to_string())],
        body.to_string(),
    )
        .into_response()
}

fn origin_of(headers: &HeaderMap) -> Origin<'_> {
    let mut all = headers.get_all(header::ORIGIN).iter();
    match (all.next(), all.next()) {
        (None, _) => Origin::Absent,
        (Some(v), None) => v.to_str().map_or(Origin::Malformed, Origin::Value),
        _ => Origin::Malformed,
    }
}

async fn handle(
    State(ctx): State<Ctx>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let headers = req.headers().clone();
    let upgrade = headers.contains_key(header::UPGRADE);
    let port = ctx.lock().port;
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    if let Err(reason) = check_host_and_origin(host, origin_of(&headers), port, &local_addresses())
    {
        if upgrade {
            return StatusCode::FORBIDDEN.into_response();
        }
        return text(
            StatusCode::FORBIDDEN,
            "text/plain; charset=utf-8",
            &format!("Refused: {reason}\n"),
        );
    }
    let path = req.uri().path().to_string();
    let ip = addr.ip().to_string();

    if upgrade {
        if path != "/ws" {
            return StatusCode::NOT_FOUND.into_response();
        }
        let offered = headers
            .get_all(header::SEC_WEBSOCKET_PROTOCOL)
            .iter()
            .filter_map(|v| v.to_str().ok());
        let token = token_from_protocol_header(offered);
        if !ctx.authorized(&ip, token.as_deref()) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let (mut parts, _) = req.into_parts();
        let Ok(ws) = WebSocketUpgrade::from_request_parts(&mut parts, &()).await else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        return ws
            .protocols([PROTOCOL_NAME])
            .max_message_size(MAX_FRAME_BYTES)
            .max_frame_size(MAX_FRAME_BYTES)
            .on_upgrade(move |socket| connection(ctx, socket));
    }

    if path == "/api/ping" {
        let provided = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.len() >= 7 && v[..7].eq_ignore_ascii_case("bearer "))
            .map(|v| v[7..].trim().to_string());
        if !ctx.authorized(&ip, provided.as_deref()) {
            return text(
                StatusCode::UNAUTHORIZED,
                "application/json; charset=utf-8",
                "{\"error\":\"unauthorized\"}\n",
            );
        }
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "application/json; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            "{\"ok\":true}\n",
        )
            .into_response();
    }

    let Some(root) = &ctx.web_root else {
        return text(
            StatusCode::SERVICE_UNAVAILABLE,
            "text/plain; charset=utf-8",
            "The remote UI has not been built. Run: npm run build:web -w desktop\n",
        );
    };
    let Some(hit) = resolve_static(root, &path) else {
        return text(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            "Not found\n",
        );
    };
    let Ok(bytes) = tokio::fs::read(&hit.path).await else {
        return text(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            "Not found\n",
        );
    };
    // Hashed asset names make long caching safe; the shell must never be
    // cached, or a rotated token's screen would come from disk.
    let cache = if hit.is_shell {
        "no-store"
    } else {
        "public, max-age=31536000, immutable"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, hit.content_type)
        .header("X-Content-Type-Options", "nosniff")
        .header(header::CACHE_CONTROL, cache)
        .header("Content-Security-Policy", SHELL_CSP)
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn connection(ctx: Ctx, mut socket: WebSocket) {
    let id = ctx.next_id.fetch_add(1, Ordering::Relaxed);
    let (out_tx, mut out) = mpsc::unbounded_channel::<String>();
    let (close_tx, mut close) = oneshot::channel();
    let _ = ctx.inbox.send(Msg::Connect {
        id,
        kind: ClientKind::Remote,
        sink: Box::new(move |line| {
            let _ = out_tx.send(line);
        }),
    });
    ctx.lock().sockets.insert(id, close_tx);
    ctx.status_changed();
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(t))) => {
                    let line = t.as_str().trim();
                    if !line.is_empty() {
                        let _ = ctx.inbox.send(Msg::Line { id, line: line.to_string() });
                    }
                }
                Some(Ok(Message::Binary(b))) => {
                    let line = String::from_utf8_lossy(&b).trim().to_string();
                    if !line.is_empty() {
                        let _ = ctx.inbox.send(Msg::Line { id, line });
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
            Some(line) = out.recv() => {
                if socket.send(Message::Text(line.into())).await.is_err() {
                    break;
                }
            }
            reason = &mut close => {
                if let Ok(Close::Revoked(reason)) = reason {
                    let frame = CloseFrame { code: CLOSE_TOKEN_REVOKED, reason: reason.into() };
                    let _ = socket.send(Message::Close(Some(frame))).await;
                }
                break;
            }
        }
    }
    // Dropped by a revoke or a stop already, or gone on its own: only the
    // latter is a change still to announce.
    let was_listed = ctx.lock().sockets.remove(&id).is_some();
    let _ = ctx.inbox.send(Msg::Disconnect { id });
    if was_listed {
        ctx.status_changed();
    }
}

impl RemoteServer {
    pub(crate) fn new(inbox: mpsc::UnboundedSender<Msg>, next_id: Arc<AtomicU64>) -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared {
                token: String::new(),
                port: 0,
                throttle: FailureThrottle::default(),
                sockets: HashMap::new(),
            })),
            inbox,
            next_id,
            running: None,
            error: None,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn status_changed(&self) {
        let _ = self.inbox.send(Msg::RemoteStatusChanged);
    }

    /// Starting on the port already bound is a no-op beyond the new token.
    pub async fn start(
        &mut self,
        port: u16,
        token: &str,
        web_root: Option<PathBuf>,
    ) -> Result<(), String> {
        self.lock().token = token.to_string();
        let current = self.lock().port;
        if self.running.is_some() && (current == port || port == 0) {
            return Ok(());
        }
        if self.running.is_some() {
            self.stop().await;
        }
        let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
            Ok(l) => l,
            Err(e) => {
                // Routine and user-facing: reported through the status, never fatal.
                let message = if e.kind() == std::io::ErrorKind::AddrInUse {
                    format!("Port {port} is already in use")
                } else {
                    e.to_string()
                };
                self.error = Some(message.clone());
                self.status_changed();
                return Err(message);
            }
        };
        // Read back: port 0 is "any free port", and the Host check compares
        // against the port actually bound.
        let bound = listener.local_addr().map_or(port, |a| a.port());
        self.lock().port = bound;
        self.error = None;
        let ctx = Ctx {
            shared: self.shared.clone(),
            inbox: self.inbox.clone(),
            next_id: self.next_id.clone(),
            web_root,
        };
        let app = Router::new().fallback(handle).with_state(ctx);
        let stop = CancellationToken::new();
        let shutdown = stop.clone();
        let task = tokio::spawn(async move {
            let service = app.into_make_service_with_connect_info::<SocketAddr>();
            if let Err(e) = axum::serve(listener, service)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await
            {
                eprintln!("[whiphand-agent] remote server error: {e}");
            }
        });
        self.running = Some((stop, task));
        self.status_changed();
        Ok(())
    }

    pub async fn stop(&mut self) {
        let sockets: Vec<_> = self.lock().sockets.drain().collect();
        let was_active = self.running.is_some() || !sockets.is_empty();
        for (_, close) in sockets {
            let _ = close.send(Close::Terminate);
        }
        if let Some((stop, task)) = self.running.take() {
            stop.cancel();
            let _ = task.await;
        }
        self.lock().port = 0;
        // Stopping what never ran is not news.
        if was_active {
            self.status_changed();
        }
    }

    /// Closes every socket with 4001, after the token is rotated.
    pub fn drop_clients(&self, reason: &str) {
        let sockets: Vec<_> = self.lock().sockets.drain().collect();
        for (_, close) in sockets {
            let _ = close.send(Close::Revoked(reason.to_string()));
        }
        self.status_changed();
    }

    pub fn status(&self) -> ServerStatus {
        ServerStatus {
            listening: self.running.is_some(),
            error: self.error.clone(),
            client_count: self.lock().sockets.len(),
        }
    }

    pub fn port(&self) -> u16 {
        self.lock().port
    }
}
