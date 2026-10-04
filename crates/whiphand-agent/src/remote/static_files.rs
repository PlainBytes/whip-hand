//! Serving the built web UI off disk (`remote/static.ts`).
//!
//! The shell is public on the LAN; the RPC channel is not. These files are
//! inert HTML, JS and CSS with no user data, and gating them would stop the QR
//! link from even rendering the screen that asks for a token. What must be
//! right is containment, so `safe_resolve` is pure and table-tested.

use std::path::{Path, PathBuf};

const CONTENT_TYPES: &[(&str, &str)] = &[
    (".html", "text/html; charset=utf-8"),
    (".js", "text/javascript; charset=utf-8"),
    (".mjs", "text/javascript; charset=utf-8"),
    (".css", "text/css; charset=utf-8"),
    (".json", "application/json; charset=utf-8"),
    (".svg", "image/svg+xml"),
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
    (".ico", "image/x-icon"),
    (".woff", "font/woff"),
    (".woff2", "font/woff2"),
    (".ttf", "font/ttf"),
    (".wasm", "application/wasm"),
    (".map", "application/json; charset=utf-8"),
    (".txt", "text/plain; charset=utf-8"),
];

/// The UI's own policy: the desktop's, minus the Tauri-only schemes. This
/// build has no tauri.conf.json to carry it, so the header is the only place.
pub const SHELL_CSP: &str = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
     worker-src 'self' blob:; connect-src 'self'";

/// Node's `path.extname`: the last segment's extension, `""` for a dotfile.
fn extname(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(0) | None => "",
        Some(i) => &name[i..],
    }
}

pub fn content_type_for(path: &str) -> &'static str {
    let ext = extname(path).to_lowercase();
    CONTENT_TYPES
        .iter()
        .find(|(e, _)| *e == ext)
        .map_or("application/octet-stream", |(_, t)| t)
}

/// `decodeURIComponent`: `%XX` escapes to UTF-8 bytes; a malformed escape or
/// invalid UTF-8 is an error rather than passed along raw.
fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A request path to a path inside `root`, or `None` if it escapes. Decoding
/// comes before the check, which is the whole point: `%2e%2e%2f` must not
/// pass as an ordinary name.
pub fn safe_resolve(root: &Path, url_path: &str) -> Option<PathBuf> {
    let path = url_path.split('?').next()?.split('#').next()?;
    let decoded = decode_uri_component(path)?;
    // A NUL truncates paths in some syscalls.
    if decoded.contains('\0') {
        return None;
    }
    // A separator on Windows: rejected everywhere so the check is the same
    // on every platform.
    if decoded.contains('\\') {
        return None;
    }
    let rest = decoded.strip_prefix('/')?;
    let mut segments: Vec<&str> = Vec::new();
    for seg in rest.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            s => segments.push(s),
        }
    }
    let mut out = root.to_path_buf();
    for seg in segments {
        out.push(seg);
    }
    Some(out)
}

pub struct StaticHit {
    pub path: PathBuf,
    pub content_type: &'static str,
    /// The `index.html` fallback for a client-side route.
    pub is_shell: bool,
}

fn is_file(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_file())
}

/// A request to a file, falling back to `index.html` for client-side routes
/// but never for something that looks like an asset: a missing chunk must
/// 404 rather than return HTML the browser would run as JavaScript.
pub fn resolve_static(root: &Path, url_path: &str) -> Option<StaticHit> {
    let target = safe_resolve(root, url_path)?;
    let shell = root.join("index.html");
    let direct = if url_path == "/" || url_path.is_empty() {
        shell.clone()
    } else {
        target
    };
    if is_file(&direct) {
        let is_shell = direct == shell;
        let content_type = content_type_for(&direct.to_string_lossy());
        return Some(StaticHit {
            path: direct,
            content_type,
            is_shell,
        });
    }
    if !extname(&direct.to_string_lossy()).is_empty() {
        return None;
    }
    is_file(&shell).then(|| StaticHit {
        content_type: content_type_for("index.html"),
        path: shell,
        is_shell: true,
    })
}

/// The built UI: `WHIPHAND_WEB_ROOT`, else the host's own location (the
/// Tauri resources), else, for a host that names none (the stdio binary in
/// a checkout), the repo's development build. It counts only if it holds an
/// `index.html`.
pub fn resolve_web_root(configured: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(v) = std::env::var("WHIPHAND_WEB_ROOT")
        && !v.is_empty()
    {
        candidates.push(PathBuf::from(v));
    }
    match configured {
        Some(dir) => candidates.push(dir.to_path_buf()),
        None => candidates
            .push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/dist-web")),
    }
    candidates
        .into_iter()
        .find(|c| c.join("index.html").is_file())
        .map(|c| std::fs::canonicalize(&c).unwrap_or(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/srv/web")
    }

    #[test]
    fn accepts_paths_inside_the_root() {
        assert_eq!(safe_resolve(&root(), "/"), Some(root()));
        assert_eq!(
            safe_resolve(&root(), "/index.html"),
            Some(root().join("index.html"))
        );
        assert_eq!(
            safe_resolve(&root(), "/assets/app-a1b2.js"),
            Some(root().join("assets").join("app-a1b2.js"))
        );
        assert_eq!(
            safe_resolve(&root(), "/assets/x.js?v=1"),
            Some(root().join("assets").join("x.js"))
        );
        assert_eq!(
            safe_resolve(&root(), "/a%20b.css"),
            Some(root().join("a b.css"))
        );
        assert_eq!(
            safe_resolve(&root(), "/.well-known/x"),
            Some(root().join(".well-known").join("x"))
        );
    }

    #[test]
    fn rejects_every_traversal_shape() {
        for path in [
            "/../../etc/passwd",
            "/..%2f..%2fetc/passwd",
            "/%2e%2e%2f%2e%2e%2fetc/passwd",
            "/assets/../../etc/passwd",
            "/..",
            "/etc/passwd\0.js",
            "/..\\..\\windows\\system32",
            "/%",
            "index.html",
            "",
        ] {
            assert_eq!(safe_resolve(&root(), path), None, "{path:?}");
        }
    }

    #[test]
    fn content_types_cover_the_bundle() {
        assert_eq!(
            content_type_for("/x/index.html"),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            content_type_for("/x/app.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type_for("/x/app.css"), "text/css; charset=utf-8");
        assert_eq!(content_type_for("/x/f.woff2"), "font/woff2");
        assert_eq!(content_type_for("/x/f.unknown"), "application/octet-stream");
    }

    #[test]
    fn serves_files_falls_back_to_the_shell_and_404s_missing_assets() {
        let dir = tempfile::tempdir().unwrap();
        let r = dir.path();
        std::fs::write(r.join("index.html"), "<!doctype html>").unwrap();
        std::fs::create_dir(r.join("assets")).unwrap();
        std::fs::write(r.join("assets").join("app.js"), "1").unwrap();
        let shell = resolve_static(r, "/").unwrap();
        assert!(shell.is_shell);
        assert_eq!(shell.content_type, "text/html; charset=utf-8");
        let asset = resolve_static(r, "/assets/app.js").unwrap();
        assert!(!asset.is_shell);
        assert_eq!(asset.path, r.join("assets").join("app.js"));
        assert!(resolve_static(r, "/runs/abc").unwrap().is_shell);
        assert!(resolve_static(r, "/assets/missing.js").is_none());
        assert!(resolve_static(r, "/../../etc/passwd").is_none());
    }

    #[test]
    fn nothing_resolves_when_the_bundle_was_never_built() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_static(dir.path(), "/").is_none());
        assert!(resolve_static(dir.path(), "/anything").is_none());
    }

    #[test]
    fn the_policy_never_allows_eval() {
        assert!(SHELL_CSP.contains("default-src 'self'"));
        assert!(!SHELL_CSP.contains("unsafe-eval"));
    }
}
