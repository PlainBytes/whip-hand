//! The settings screen: the workspace's and the global config, as the
//! desktop's WorkspaceSettingsPage and PreferencesPage edit them, the TUI's
//! own preferences, and each runner's models.

use serde_json::Value;
use whiphand_protocol::{ConfigGetResult, ListModelsResult};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Pane {
    #[default]
    Workspace,
    Global,
    Tui,
    Models,
}

impl Pane {
    pub const ALL: [Pane; 4] = [Pane::Workspace, Pane::Global, Pane::Tui, Pane::Models];

    pub fn title(self) -> &'static str {
        match self {
            Pane::Workspace => "This workspace",
            Pane::Global => "Everywhere (global)",
            Pane::Tui => "Terminal UI",
            Pane::Models => "Models",
        }
    }

    pub fn next(self) -> Pane {
        let i = Pane::ALL.iter().position(|p| *p == self).unwrap_or(0);
        Pane::ALL[(i + 1) % Pane::ALL.len()]
    }
}

/// A config leaf the screen edits, in the desktop's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Runner,
    OnFindings,
    MaxIterations,
    ArtifactsDir,
    MaxRetained,
    AutoName,
}

impl Key {
    pub const ALL: [Key; 6] = [
        Key::Runner,
        Key::OnFindings,
        Key::MaxIterations,
        Key::ArtifactsDir,
        Key::MaxRetained,
        Key::AutoName,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Key::Runner => "Default runner",
            Key::OnFindings => "When a step reports findings",
            Key::MaxIterations => "Max fix-loop iterations",
            Key::ArtifactsDir => "Artifacts directory",
            Key::MaxRetained => "Maximum runs kept",
            Key::AutoName => "Name runs automatically",
        }
    }

    /// Where the leaf sits in a config, or a config layer.
    pub fn path(self) -> &'static [&'static str] {
        match self {
            Key::Runner => &["defaults", "runner"],
            Key::OnFindings => &["on_findings"],
            Key::MaxIterations => &["loop", "max_iterations"],
            Key::ArtifactsDir => &["artifacts_dir"],
            Key::MaxRetained => &["runs", "max_retained"],
            Key::AutoName => &["runs", "auto_name"],
        }
    }

    /// The leaf in `config`; `None` when the layer does not set it.
    pub fn get(self, config: &Value) -> Option<&Value> {
        self.path().iter().try_fold(config, |v, k| v.get(*k))
    }

    /// Sets the leaf in a whole config.
    pub fn set(self, config: &mut Value, value: Value) {
        let (last, parents) = self.path().split_last().expect("a path");
        let mut at = config;
        for k in parents {
            at = at
                .as_object_mut()
                .expect("a config is an object")
                .entry(*k)
                .or_insert_with(|| Value::Object(Default::default()));
        }
        if let Some(obj) = at.as_object_mut() {
            obj.insert((*last).to_string(), value);
        }
    }

    /// The leaf as the screen shows it.
    pub fn show(self, config: &Value) -> String {
        match (self, self.get(config)) {
            (Key::MaxRetained, None | Some(Value::Null)) => "keep everything".into(),
            (Key::OnFindings, Some(Value::String(s))) => on_findings_label(s).into(),
            (Key::AutoName, Some(Value::Bool(b))) => if *b { "yes" } else { "no" }.into(),
            (_, Some(Value::String(s))) => s.clone(),
            (_, Some(v)) => v.to_string(),
            (_, None) => "—".into(),
        }
    }
}

pub const ON_FINDINGS: [&str; 3] = ["report", "loop", "interactive"];

pub fn on_findings_label(value: &str) -> &str {
    match value {
        "report" => "report only",
        "loop" => "loop until fixed",
        "interactive" => "ask me",
        other => other,
    }
}

#[derive(Debug, Default)]
pub struct SettingsUi {
    pub pane: Pane,
    /// The row in focus on a config or TUI pane.
    pub selected: usize,
    /// `configGet` with the workspace: the merged config and both layers.
    pub project: Option<ConfigGetResult>,
    /// `configGet` without one: defaults plus the global layer, which is
    /// what a workspace inherits.
    pub global: Option<ConfigGetResult>,
    pub models: Option<ListModelsResult>,
    pub scroll: u16,
}

impl SettingsUi {
    /// Whether the workspace's own layer sets `key`: the honest sign of an
    /// override, since the merged value may equal the inherited one.
    pub fn overrides(&self, key: Key) -> bool {
        self.project
            .as_ref()
            .and_then(|r| r.project.as_ref())
            .is_some_and(|l| key.get(&l.config).is_some())
    }

    /// Whether the global layer sets `key`, rather than the default.
    pub fn global_sets(&self, key: Key) -> bool {
        self.global
            .as_ref()
            .is_some_and(|r| key.get(&r.global.config).is_some())
    }

    /// The merged config a pane edits.
    pub fn config(&self, pane: Pane) -> Option<&Value> {
        match pane {
            Pane::Workspace => self.project.as_ref().map(|r| &r.config),
            Pane::Global => self.global.as_ref().map(|r| &r.config),
            Pane::Tui | Pane::Models => None,
        }
    }

    /// The runners `listModels` knows, in its order.
    pub fn runners(&self) -> Vec<String> {
        self.models
            .as_ref()
            .map(|m| m.0.keys().cloned().collect())
            .unwrap_or_default()
    }
}

/// The TUI pane's rows.
pub const TUI_ROWS: usize = 3;

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn leaves_read_and_write_through_their_path() {
        let mut config = json!({ "defaults": { "runner": "claude" }, "runs": {} });
        assert_eq!(Key::Runner.get(&config), Some(&json!("claude")));
        assert_eq!(Key::MaxRetained.get(&config), None);
        assert_eq!(Key::MaxRetained.show(&config), "keep everything");
        Key::MaxRetained.set(&mut config, json!(20));
        Key::MaxIterations.set(&mut config, json!(5));
        assert_eq!(config["runs"]["max_retained"], 20);
        assert_eq!(config["loop"]["max_iterations"], 5);
        assert_eq!(Key::MaxRetained.show(&config), "20");
        Key::OnFindings.set(&mut config, json!("loop"));
        assert_eq!(Key::OnFindings.show(&config), "loop until fixed");
    }

    #[test]
    fn panes_cycle() {
        assert_eq!(Pane::Models.next(), Pane::Workspace);
        assert_eq!(Pane::Workspace.next(), Pane::Global);
    }
}
