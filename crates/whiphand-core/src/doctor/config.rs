//! `doctor-config.ts`: the user's own doctor probes, `<configHome>/doctor.yaml`.
//! A separate file from config.yaml because nothing ever rewrites it, and a
//! strict schema: a misspelled key in a hand-written table is reported, not
//! silently ignored. Problems carry zod 4's own messages and name the file.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::config_home::host_config_home;
use crate::doctor::tools::{Group, ToolProbe};
use crate::raw::{Raw, parse_yaml};
use crate::schema::WorkflowError;
use crate::zod::{self, Code, Ctx};

pub fn global_doctor_config_path() -> PathBuf {
    host_config_home().join("doctor.yaml")
}

/// The parsed file: extra probes, and ids to hide.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DoctorToolsConfig {
    pub tools: Option<Vec<ToolProbe>>,
    pub hide: Option<Vec<String>>,
}

static BARE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*$").unwrap());

/// `z.strictObject`'s closing check: one issue naming every unknown key.
fn unrecognized(cx: &mut Ctx, map: &crate::js::Record<Raw>, known: &[&str]) {
    let extra: Vec<String> = map
        .keys()
        .filter(|k| !known.contains(k))
        .map(|k| format!("\"{k}\""))
        .collect();
    if extra.is_empty() {
        return;
    }
    let s = if extra.len() > 1 { "s" } else { "" };
    cx.push(
        Code::Custom,
        format!("Unrecognized key{s}: {}", extra.join(", ")),
        true,
    );
}

fn url_ok(s: &str) -> bool {
    url::Url::parse(s.trim_matches(crate::js::is_js_whitespace)).is_ok()
}

fn tool(cx: &mut Ctx, v: Option<&Raw>) -> Option<ToolProbe> {
    let map = zod::object(cx, v)?;
    let id = cx.key("id", |cx| {
        let s = zod::string(cx, map.get("id"))?;
        if BARE_ID.is_match(&s) {
            Some(s)
        } else {
            cx.push(
                Code::Custom,
                "must be a bare name (no whitespace or slashes)",
                true,
            );
            None
        }
    });
    let label = cx.key("label", |cx| zod::string_min1(cx, map.get("label")));
    let group = cx.key("group", |cx| {
        zod::enumeration(
            cx,
            map.get("group"),
            &[("harness", Group::Harness), ("support", Group::Support)],
        )
    });
    let argv = cx.key("argv", |cx| {
        zod::array(cx, map.get("argv"), true, zod::string_min1)
    });
    let aliases = cx.key("aliases", |cx| {
        zod::optional(cx, map.get("aliases"), |cx, v| {
            zod::array(cx, v, false, zod::string_min1)
        })
    });
    let version_pattern = cx.key("version_pattern", |cx| {
        zod::optional(cx, map.get("version_pattern"), zod::string_min1)
    });
    let optional = cx.key("optional", |cx| {
        zod::optional(cx, map.get("optional"), zod::boolean)
    });
    let url = cx.key("url", |cx| {
        zod::optional(cx, map.get("url"), |cx, v| {
            let s = zod::string(cx, v)?;
            if url_ok(&s) {
                // zod's `.url()` hands back the trimmed value.
                Some(s.trim_matches(crate::js::is_js_whitespace).to_string())
            } else {
                cx.push(Code::Custom, "Invalid URL", true);
                None
            }
        })
    });
    unrecognized(
        cx,
        map,
        &[
            "id",
            "label",
            "group",
            "argv",
            "aliases",
            "version_pattern",
            "optional",
            "url",
        ],
    );
    Some(ToolProbe {
        id: id?,
        label: label?,
        group: group?,
        argv: argv?,
        aliases: aliases?.unwrap_or_default(),
        version_pattern: version_pattern?,
        optional: optional?,
        url: url?,
        check: None,
    })
}

fn doctor_config(cx: &mut Ctx, v: &Raw) -> Option<DoctorToolsConfig> {
    let map = zod::object(cx, Some(v))?;
    let tools = cx.key("tools", |cx| {
        zod::optional(cx, map.get("tools"), |cx, v| zod::array(cx, v, false, tool))
    });
    let hide = cx.key("hide", |cx| {
        zod::optional(cx, map.get("hide"), |cx, v| {
            zod::array(cx, v, false, zod::string_min1)
        })
    });
    unrecognized(cx, map, &["tools", "hide"]);
    Some(DoctorToolsConfig {
        tools: tools?,
        hide: hide?,
    })
}

/// A missing file is an empty config; every failure past that names `path`.
pub fn load_doctor_config(path: &Path) -> Result<DoctorToolsConfig, WorkflowError> {
    let Ok(bytes) = std::fs::read(path) else {
        return Ok(DoctorToolsConfig::default());
    };
    let text = String::from_utf8_lossy(&bytes);
    let shown = path.display();
    let raw = match parse_yaml(&text) {
        Ok(Raw::Null) => Raw::Map(Default::default()),
        Ok(raw) => raw,
        Err(e) => {
            return Err(WorkflowError {
                problems: vec![format!("{shown}: {e}")],
                yaml: true,
            });
        }
    };
    let mut cx = Ctx::new();
    let parsed = doctor_config(&mut cx, &raw);
    if !cx.issues.is_empty() {
        return Err(WorkflowError::new(
            cx.issues
                .iter()
                .map(|i| {
                    let at = i
                        .path
                        .iter()
                        .map(|s| s.display())
                        .collect::<Vec<_>>()
                        .join(".");
                    if at.is_empty() {
                        format!("{shown}: {}", i.message)
                    } else {
                        format!("{shown}: {at}: {}", i.message)
                    }
                })
                .collect(),
        ));
    }
    let config = parsed.unwrap_or_default();
    let problems: Vec<String> = config
        .tools
        .iter()
        .flatten()
        .filter_map(|t| {
            let p = t.version_pattern.as_ref()?;
            Regex::new(p)
                .err()
                .map(|e| format!("{shown}: tools.{}.version_pattern: {e}", t.id))
        })
        .collect();
    if !problems.is_empty() {
        return Err(WorkflowError::new(problems));
    }
    Ok(config)
}
