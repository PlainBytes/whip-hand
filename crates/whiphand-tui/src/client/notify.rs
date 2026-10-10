//! The agent's notifications, typed with `whiphand-protocol`'s params.

use serde::de::DeserializeOwned;
use serde_json::Value;
use whiphand_protocol as p;

#[derive(Debug)]
pub enum Notification {
    WhiphandEvent(p::WhiphandEventParams),
    RunStateChanged(p::RunStateChangedParams),
    PtyStarted(p::PtyStartedParams),
    PtyData(p::PtyDataParams),
    PtyExit(p::PtyExitParams),
    PtyAwait(p::PtyAwaitParams),
    StepLog(p::StepLogParams),
    ManualRequest(p::ManualRequestParams),
    ManualResolved(p::ManualResolvedParams),
    AppStateChanged(Box<p::AppStateChangedParams>),
    /// Desktop-only (`remoteAccessChanged`), or a notification newer than
    /// this build: nothing to do.
    Ignored(String),
}

fn typed<T: DeserializeOwned>(method: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| format!("{method}: unexpected params: {e}"))
}

impl Notification {
    pub fn parse(method: &str, params: Value) -> Result<Notification, String> {
        use Notification as N;
        Ok(match method {
            "whiphandEvent" => N::WhiphandEvent(typed(method, params)?),
            "runStateChanged" => N::RunStateChanged(typed(method, params)?),
            "ptyStarted" => N::PtyStarted(typed(method, params)?),
            "ptyData" => N::PtyData(typed(method, params)?),
            "ptyExit" => N::PtyExit(typed(method, params)?),
            "ptyAwait" => N::PtyAwait(typed(method, params)?),
            "stepLog" => N::StepLog(typed(method, params)?),
            "manualRequest" => N::ManualRequest(typed(method, params)?),
            "manualResolved" => N::ManualResolved(typed(method, params)?),
            "appStateChanged" => N::AppStateChanged(Box::new(typed(method, params)?)),
            other => N::Ignored(other.to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Only remoteAccessChanged is ignored on purpose; any other protocol
    // notification gets a variant.
    #[test]
    fn every_protocol_notification_but_remote_access_has_a_variant() {
        for (name, _) in p::NOTIFICATIONS {
            let n = Notification::parse(name, Value::Null);
            let ignored = matches!(n, Ok(Notification::Ignored(_)));
            assert_eq!(ignored, *name == "remoteAccessChanged", "{name}");
        }
    }
}
