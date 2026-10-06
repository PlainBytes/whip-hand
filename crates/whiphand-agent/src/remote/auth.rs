//! The remote channel's guards (`remote/auth.ts`): pure functions, so the
//! security decisions are table-tested rather than discovered.
//!
//! The threat is DNS rebinding: a page elsewhere points a hostname it owns at
//! this machine's LAN address and talks to the agent from the victim's
//! browser. CORS does not cover a WebSocket upgrade, and this RPC channel
//! runs commands, so three layers stand in the way:
//!   1. Host must name an address this agent binds, on the port it listens
//!      on. A rebound page sends `Host: evil.example:PORT`. This one does not
//!      depend on the browser behaving, which makes it the primary defense.
//!   2. Origin, when present, must be the origin we serve.
//!   3. The token lives in origin-scoped storage in the web client.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::Engine as _;

/// 256 bits, base64url so it survives a URL fragment and a QR code.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random source");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Constant-time compare; the length check leaks only the fixed, public length.
pub fn token_matches(expected: &str, provided: Option<&str>) -> bool {
    let Some(provided) = provided.filter(|p| !p.is_empty()) else {
        return false;
    };
    let (a, b) = (expected.as_bytes(), provided.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The token rides in `Sec-WebSocket-Protocol` as `whiphand.token.<token>`:
/// the one handshake header a browser lets a page set, and unlike a URL it
/// reaches no log, history or Referer.
pub const TOKEN_PROTOCOL_PREFIX: &str = "whiphand.token.";

/// The non-secret protocol the server echoes back, so the token appears only
/// in the request.
pub const PROTOCOL_NAME: &str = "whiphand";

/// The token in an offered protocol list (every header value, comma-split).
pub fn token_from_protocol_header<'a>(values: impl IntoIterator<Item = &'a str>) -> Option<String> {
    values
        .into_iter()
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .find_map(|v| v.strip_prefix(TOKEN_PROTOCOL_PREFIX).map(str::to_string))
}

const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// Loopback plus this machine's non-internal IPv4 addresses, recomputed per
/// call: a laptop changes networks, and a stale list fails closed.
pub fn local_addresses() -> Vec<String> {
    let mut out: Vec<String> = LOOPBACK_HOSTS.iter().map(|s| s.to_string()).collect();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if let std::net::IpAddr::V4(ip) = iface.ip()
                && !iface.is_loopback()
            {
                out.push(ip.to_string());
            }
        }
    }
    out
}

/// The addresses to offer the user, loopback only as a fallback. Addresses,
/// not URLs: a URL would carry the token, and this travels to every client.
pub fn lan_addresses() -> Vec<String> {
    let lan: Vec<String> = local_addresses()
        .into_iter()
        .filter(|a| !LOOPBACK_HOSTS.contains(&a.as_str()))
        .collect();
    if lan.is_empty() {
        vec!["127.0.0.1".into()]
    } else {
        lan
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostPort {
    pub host: String,
    pub port: Option<u16>,
}

/// JS `Number(s)` as a port: an integer in 1..=65535, or nothing.
fn port_of(s: &str) -> Option<Option<u16>> {
    let n = whiphand_core::js::string_to_number(s);
    (n.fract() == 0.0 && n > 0.0 && n <= 65535.0).then_some(Some(n as u16))
}

/// Host and port of an authority, unwrapping an IPv6 literal's brackets.
/// `None` for anything malformed, which a caller must treat as a refusal.
pub fn parse_authority(value: Option<&str>) -> Option<HostPort> {
    let raw = value?.trim().to_lowercase();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix('[') {
        let close = rest.find(']')?;
        let host = rest[..close].to_string();
        let after = &rest[close + 1..];
        if after.is_empty() {
            return Some(HostPort { host, port: None });
        }
        let port = port_of(after.strip_prefix(':')?)?;
        return Some(HostPort { host, port });
    }
    let Some(colon) = raw.rfind(':') else {
        return Some(HostPort {
            host: raw,
            port: None,
        });
    };
    // A bare IPv6 with no brackets and no port.
    if raw.find(':') != Some(colon) {
        return Some(HostPort {
            host: raw,
            port: None,
        });
    }
    let host = raw[..colon].to_string();
    if host.is_empty() {
        return None;
    }
    let port = port_of(&raw[colon + 1..])?;
    Some(HostPort { host, port })
}

/// The Origin header as received.
#[derive(Clone, Copy, Debug)]
pub enum Origin<'a> {
    Absent,
    Value(&'a str),
    /// Repeated, or not text.
    Malformed,
}

/// Why a request is refused, or `Ok` to go on. `port` is the port actually
/// bound: a Host naming the right address on another port did not reach us
/// the way it claims.
pub fn check_host_and_origin(
    host: Option<&str>,
    origin: Origin,
    port: u16,
    allowed: &[String],
) -> Result<(), String> {
    let authority = parse_authority(host).ok_or("missing or malformed Host header")?;
    if !allowed.iter().any(|a| a.to_lowercase() == authority.host) {
        return Err(format!(
            "Host '{}' is not an address this agent binds",
            authority.host
        ));
    }
    // No explicit port means the client believes we are on 80; we never are.
    let claimed = authority.port.unwrap_or(80);
    if claimed != port {
        return Err(format!(
            "Host port {claimed} is not the listening port {port}"
        ));
    }
    let origin = match origin {
        // Only a non-browser can omit Origin on an upgrade or a cross-origin
        // fetch, and that is not the rebinding threat.
        Origin::Absent => return Ok(()),
        Origin::Malformed => return Err("malformed Origin header".into()),
        Origin::Value(v) => v.trim().to_lowercase(),
    };
    // A sandboxed iframe or a redirect sends 'null'; neither should reach us.
    if origin == "null" {
        return Err("Origin 'null' is not allowed".into());
    }
    let host = if authority.host.contains(':') {
        format!("[{}]", authority.host)
    } else {
        authority.host.clone()
    };
    let expected = format!("http://{host}:{port}");
    if origin != expected {
        return Err(format!(
            "Origin '{origin}' does not match the served origin '{expected}'"
        ));
    }
    Ok(())
}

/// Per-IP failure throttle. A 256-bit token cannot be guessed on a LAN; this
/// stops a misconfigured client from spinning.
pub struct FailureThrottle {
    max: u32,
    window: Duration,
    hits: HashMap<String, (u32, Instant)>,
}

impl Default for FailureThrottle {
    fn default() -> Self {
        Self::new(10, Duration::from_secs(5))
    }
}

impl FailureThrottle {
    pub fn new(max: u32, window: Duration) -> Self {
        Self {
            max,
            window,
            hits: HashMap::new(),
        }
    }

    pub fn blocked(&mut self, key: &str, now: Instant) -> bool {
        match self.hits.get(key) {
            None => false,
            Some((_, until)) if now >= *until => {
                self.hits.remove(key);
                false
            }
            Some((count, _)) => *count >= self.max,
        }
    }

    pub fn record(&mut self, key: &str, now: Instant) {
        let until = now + self.window;
        match self.hits.get_mut(key) {
            Some((count, end)) if now < *end => {
                *count += 1;
                *end = until;
            }
            _ => {
                self.hits.insert(key.to_string(), (1, until));
            }
        }
    }

    pub fn clear(&mut self, key: &str) {
        self.hits.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 61338;

    fn allowed() -> Vec<String> {
        ["localhost", "127.0.0.1", "::1", "192.168.1.20"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn tokens_are_distinct_256_bit_base64url() {
        let (a, b) = (generate_token(), generate_token());
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }

    #[test]
    fn only_the_exact_token_matches() {
        let t = generate_token();
        assert!(token_matches(&t, Some(&t)));
        assert!(!token_matches(&t, Some(&format!("{t}x"))));
        assert!(!token_matches(&t, Some(&t[..t.len() - 1])));
        assert!(!token_matches(&t, Some(&format!("{}!", &t[..t.len() - 1]))));
        assert!(!token_matches(&t, None));
        assert!(!token_matches(&t, Some("")));
    }

    #[test]
    fn the_token_comes_out_of_the_offered_list() {
        assert_eq!(token_from_protocol_header([]), None);
        assert_eq!(token_from_protocol_header(["other-protocol"]), None);
        assert_eq!(
            token_from_protocol_header(["whiphand.token.abc123"]),
            Some("abc123".into())
        );
        assert_eq!(
            token_from_protocol_header(["other-protocol, whiphand.token.abc123"]),
            Some("abc123".into())
        );
        assert_eq!(
            token_from_protocol_header(["other-protocol", "whiphand.token.abc123"]),
            Some("abc123".into())
        );
    }

    #[test]
    fn parse_authority_table() {
        let hp = |host: &str, port: Option<u16>| {
            Some(HostPort {
                host: host.into(),
                port,
            })
        };
        let cases: [(Option<&str>, Option<HostPort>); 14] = [
            (Some("192.168.1.20:61338"), hp("192.168.1.20", Some(61338))),
            (Some("LOCALHOST:61338"), hp("localhost", Some(61338))),
            (Some("localhost"), hp("localhost", None)),
            (Some("[::1]:61338"), hp("::1", Some(61338))),
            (Some("[::1]"), hp("::1", None)),
            (Some("::1"), hp("::1", None)),
            (Some("[::1"), None),
            (Some("[::1]x61338"), None),
            (Some("host:notaport"), None),
            (Some("host:0"), None),
            (Some("host:70000"), None),
            (Some(":61338"), None),
            (Some(""), None),
            (None, None),
        ];
        for (input, expected) in cases {
            assert_eq!(parse_authority(input), expected, "{input:?}");
        }
    }

    #[test]
    fn host_must_name_a_bound_address_on_the_listening_port() {
        let ok = |host: Option<&str>| {
            check_host_and_origin(host, Origin::Absent, PORT, &allowed()).is_ok()
        };
        assert!(ok(Some("192.168.1.20:61338")), "LAN address, right port");
        assert!(ok(Some("localhost:61338")), "loopback name");
        assert!(ok(Some("[::1]:61338")), "IPv6 loopback");
        assert!(!ok(Some("evil.example:61338")), "DNS rebinding");
        assert!(!ok(Some("192.168.1.20:1234")), "wrong port");
        assert!(!ok(Some("192.168.1.20")), "no port means 80");
        assert!(
            !ok(Some("10.0.0.9:61338")),
            "an address this machine does not have"
        );
        assert!(!ok(None), "missing Host");
        assert!(!ok(Some("")), "empty Host");
    }

    #[test]
    fn origin_when_present_must_match_the_served_origin() {
        let check = |o: Origin| {
            check_host_and_origin(Some("192.168.1.20:61338"), o, PORT, &allowed()).is_ok()
        };
        assert!(check(Origin::Absent));
        assert!(check(Origin::Value("http://192.168.1.20:61338")));
        assert!(
            check(Origin::Value("HTTP://192.168.1.20:61338")),
            "case-insensitive"
        );
        assert!(!check(Origin::Value("null")));
        assert!(!check(Origin::Value("http://evil.example")));
        assert!(!check(Origin::Value("http://192.168.1.20:1234")));
        assert!(
            !check(Origin::Value("https://192.168.1.20:61338")),
            "we do not serve https"
        );
        assert!(!check(Origin::Malformed));
    }

    #[test]
    fn an_ipv6_host_builds_a_bracketed_origin() {
        assert!(
            check_host_and_origin(
                Some("[::1]:61338"),
                Origin::Value("http://[::1]:61338"),
                PORT,
                &allowed()
            )
            .is_ok()
        );
    }

    #[test]
    fn a_refusal_names_why() {
        let e = check_host_and_origin(Some("evil.example:61338"), Origin::Absent, PORT, &allowed())
            .unwrap_err();
        assert!(e.contains("evil.example"), "{e}");
    }

    #[test]
    fn local_addresses_include_loopback() {
        let addrs = local_addresses();
        for l in LOOPBACK_HOSTS {
            assert!(addrs.iter().any(|a| a == l), "{l}");
        }
    }

    #[test]
    fn the_throttle_blocks_then_expires_and_clears() {
        let mut t = FailureThrottle::new(3, Duration::from_millis(1000));
        let now = Instant::now();
        assert!(!t.blocked("1.2.3.4", now));
        for _ in 0..3 {
            t.record("1.2.3.4", now);
        }
        assert!(t.blocked("1.2.3.4", now));
        assert!(!t.blocked("5.6.7.8", now), "per IP");
        let later = now + Duration::from_millis(1001);
        assert!(!t.blocked("1.2.3.4", later), "window expired");
        for _ in 0..3 {
            t.record("1.2.3.4", later);
        }
        assert!(t.blocked("1.2.3.4", later));
        t.clear("1.2.3.4");
        assert!(!t.blocked("1.2.3.4", later), "a success clears the counter");
    }
}
