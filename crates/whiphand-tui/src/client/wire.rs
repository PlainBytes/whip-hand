//! One line from the agent: a response to one of our requests, or a
//! notification for every client.

use serde_json::Value;
use whiphand_protocol::RpcError;

use super::notify::Notification;

#[derive(Debug)]
pub enum Inbound {
    Reply {
        id: u64,
        result: Result<Value, RpcError>,
    },
    Notification(Notification),
    /// Not a line the protocol defines; logged, never fatal.
    Garbled(String),
}

pub fn parse(line: &str) -> Inbound {
    let garbled = |why: &str| Inbound::Garbled(format!("{why}: {line}"));
    let Ok(Value::Object(mut obj)) = serde_json::from_str::<Value>(line) else {
        return garbled("not a JSON object");
    };
    if let Some(Value::String(method)) = obj.remove("method") {
        let params = obj.remove("params").unwrap_or(Value::Null);
        return match Notification::parse(&method, params) {
            Ok(n) => Inbound::Notification(n),
            Err(e) => Inbound::Garbled(e),
        };
    }
    let Some(id) = obj.get("id").and_then(Value::as_f64).map(|n| n as u64) else {
        return garbled("a response without an id");
    };
    if let Some(error) = obj.remove("error") {
        return match serde_json::from_value(error) {
            Ok(e) => Inbound::Reply { id, result: Err(e) },
            Err(_) => garbled("a malformed error"),
        };
    }
    match obj.remove("result") {
        Some(result) => Inbound::Reply {
            id,
            result: Ok(result),
        },
        None => garbled("a response with neither result nor error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_results_errors_and_notifications() {
        let Inbound::Reply {
            id: 3,
            result: Ok(v),
        } = parse(r#"{"id":3,"result":{"a":1}}"#)
        else {
            panic!()
        };
        assert_eq!(v["a"], 1);
        let Inbound::Reply {
            id: 4,
            result: Err(e),
        } = parse(r#"{"id":4,"error":{"code":-32601,"message":"method not found: x"}}"#)
        else {
            panic!()
        };
        assert_eq!(e.code, -32601);
        assert!(matches!(
            parse(r#"{"method":"runStateChanged","params":{"jobId":"j","status":"running"}}"#),
            Inbound::Notification(Notification::RunStateChanged(_))
        ));
        assert!(matches!(parse("nope"), Inbound::Garbled(_)));
    }
}
