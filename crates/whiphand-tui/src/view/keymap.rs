//! Every key binding, in one table: `update` dispatches through it, and the
//! `?` overlay and the footer hints are drawn from it (docs/tui-plan.md,
//! section 6).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::model::Route;
use crate::model::input::alt_gr;

/// Where a binding applies. A screen's own bindings are looked up first,
/// then the global ones; `Goto` is the second key of a `g` chord.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ctx {
    Global,
    Goto,
    Workspaces,
    Runs,
    Detail,
    Doctor,
    NewRun,
    Manual,
    Workflows,
    Settings,
}

impl Ctx {
    pub fn of(route: &Route) -> Ctx {
        match route {
            Route::Workspaces => Ctx::Workspaces,
            Route::Runs => Ctx::Runs,
            Route::RunDetail => Ctx::Detail,
            Route::Doctor => Ctx::Doctor,
            Route::NewRun => Ctx::NewRun,
            Route::Manual => Ctx::Manual,
            Route::Workflows => Ctx::Workflows,
            Route::Settings => Ctx::Settings,
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Ctx::Global => "Everywhere",
            Ctx::Goto => "Go to (after g)",
            Ctx::Workspaces => "Workspaces",
            Ctx::Runs => "Runs",
            Ctx::Detail => "Run detail",
            Ctx::Doctor => "Doctor",
            Ctx::NewRun => "New run",
            Ctx::Manual => "Manual or approval step",
            Ctx::Workflows => "Workflows",
            Ctx::Settings => "Settings",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Help,
    Back,
    Quit,
    Goto,
    GoWorkspaces,
    GoRuns,
    GoDoctor,
    GoWorkflows,
    GoSettings,
    Down,
    Up,
    PageDown,
    PageUp,
    Top,
    Bottom,
    Open,
    Filter,
    Ongoing,
    Pin,
    NextPane,
    Tab(u8),
    ErrorsOnly,
    AllSteps,
    Collapse,
    Expand,
    Pager,
    ExternalDiff,
    Refresh,
    /// Ctrl-c: cancel the run in focus, else quit; both ask first.
    Interrupt,
    Cancel,
    Resume,
    Rename,
    Lock,
    Delete,
    EndSession,
    NewRun,
    ContinueInWorktree,
    StartRun,
    OpenManual,
    Approve,
    SendBack,
    AbortStep,
    EditNote,
    Attach,
    /// `$EDITOR` on the thing in focus: a workflow, an artifact.
    Edit,
    RunWorkflow,
    NewWorkflow,
    NewWorkspaceWorkflow,
    NewGlobalWorkflow,
    CloneWorkflow,
    InitWorkspace,
    OpenPath,
    /// Settings: drop the workspace's override of the row.
    Inherit,
    Prune,
}

/// A key as the table spells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Ctrl(char),
    Code(KeyCode),
}

impl Key {
    fn matches(self, ev: &KeyEvent) -> bool {
        // AltGr (Ctrl and Alt on Windows) types a character, not a chord.
        let ctrl = ev.modifiers.contains(KeyModifiers::CONTROL) && alt_gr(ev).is_none();
        match self {
            Key::Char(c) => !ctrl && ev.code == KeyCode::Char(c),
            Key::Ctrl(c) => ctrl && ev.code == KeyCode::Char(c),
            Key::Code(code) => ev.code == code,
        }
    }
}

pub struct Binding {
    pub ctx: Ctx,
    pub keys: &'static [Key],
    /// How the overlay spells the keys.
    pub label: &'static str,
    pub action: Action,
    pub help: &'static str,
}

use Action as A;
use Ctx as C;
use Key::{Char, Code, Ctrl};

const fn b(
    ctx: Ctx,
    keys: &'static [Key],
    label: &'static str,
    action: Action,
    help: &'static str,
) -> Binding {
    Binding {
        ctx,
        keys,
        label,
        action,
        help,
    }
}

pub const BINDINGS: &[Binding] = &[
    b(C::Global, &[Char('?')], "?", A::Help, "this help"),
    b(
        C::Global,
        &[Char('q'), Code(KeyCode::Esc)],
        "q Esc",
        A::Back,
        "back; quit from the first screen",
    ),
    b(C::Global, &[Char('Q')], "Q", A::Quit, "quit"),
    b(
        C::Global,
        &[Ctrl('c')],
        "Ctrl-c",
        A::Interrupt,
        "cancel the run in focus, else quit",
    ),
    b(
        C::Global,
        &[Char('g')],
        "g",
        A::Goto,
        "go to a screen (then w, r, f, d or s)",
    ),
    b(
        C::Global,
        &[Char('j'), Code(KeyCode::Down)],
        "j ↓",
        A::Down,
        "down",
    ),
    b(
        C::Global,
        &[Char('k'), Code(KeyCode::Up)],
        "k ↑",
        A::Up,
        "up",
    ),
    b(
        C::Global,
        &[Code(KeyCode::PageDown), Ctrl('d')],
        "PgDn Ctrl-d",
        A::PageDown,
        "page down",
    ),
    b(
        C::Global,
        &[Code(KeyCode::PageUp), Ctrl('u')],
        "PgUp Ctrl-u",
        A::PageUp,
        "page up",
    ),
    b(C::Global, &[Code(KeyCode::Home)], "Home", A::Top, "top"),
    b(
        C::Global,
        &[Char('G'), Code(KeyCode::End)],
        "G End",
        A::Bottom,
        "bottom; the log follows again",
    ),
    b(C::Global, &[Code(KeyCode::Enter)], "Enter", A::Open, "open"),
    b(C::Goto, &[Char('w')], "g w", A::GoWorkspaces, "workspaces"),
    b(C::Goto, &[Char('r')], "g r", A::GoRuns, "runs"),
    b(C::Goto, &[Char('f')], "g f", A::GoWorkflows, "workflows"),
    b(C::Goto, &[Char('d')], "g d", A::GoDoctor, "doctor"),
    b(C::Goto, &[Char('s')], "g s", A::GoSettings, "settings"),
    b(C::Workspaces, &[Char('p')], "p", A::Pin, "pin or unpin"),
    b(
        C::Workspaces,
        &[Char('a')],
        "a",
        A::OpenPath,
        "open a folder by its path",
    ),
    b(C::Runs, &[Char('/')], "/", A::Filter, "filter"),
    b(C::Runs, &[Char('n')], "n", A::NewRun, "new run"),
    b(
        C::Runs,
        &[Char('m')],
        "m",
        A::OpenManual,
        "answer the step waiting on you",
    ),
    b(
        C::Runs,
        &[Char('o')],
        "o",
        A::Ongoing,
        "ongoing runs in every workspace",
    ),
    b(C::Runs, &[Char('c')], "c", A::Cancel, "cancel the run"),
    b(C::Runs, &[Char('r')], "r", A::Resume, "resume the run"),
    b(C::Runs, &[Char('R')], "R", A::Rename, "rename the run"),
    b(
        C::Runs,
        &[Char('L')],
        "L",
        A::Lock,
        "lock or unlock the run",
    ),
    b(C::Runs, &[Char('x')], "x", A::Delete, "delete the run"),
    b(
        C::Detail,
        &[Code(KeyCode::Tab), Code(KeyCode::BackTab)],
        "Tab",
        A::NextPane,
        "switch pane",
    ),
    b(C::Detail, &[Char('1')], "1", A::Tab(0), "log"),
    b(C::Detail, &[Char('2')], "2", A::Tab(1), "events"),
    b(C::Detail, &[Char('3')], "3", A::Tab(2), "artifacts"),
    b(C::Detail, &[Char('4')], "4", A::Tab(3), "diff"),
    b(
        C::Detail,
        &[Char('h'), Code(KeyCode::Left)],
        "h ←",
        A::Collapse,
        "collapse",
    ),
    b(
        C::Detail,
        &[Char('l'), Code(KeyCode::Right)],
        "l →",
        A::Expand,
        "expand",
    ),
    b(C::Detail, &[Char('f')], "f", A::ErrorsOnly, "errors only"),
    b(
        C::Detail,
        &[Char('A')],
        "A",
        A::AllSteps,
        "every step's rows",
    ),
    b(
        C::Detail,
        &[Char('o')],
        "o",
        A::Pager,
        "open the artifact in $PAGER",
    ),
    b(
        C::Detail,
        &[Char('D')],
        "D",
        A::ExternalDiff,
        "git diff in a terminal",
    ),
    b(
        C::Detail,
        &[Ctrl('r')],
        "Ctrl-r",
        A::Refresh,
        "reload the diff",
    ),
    b(C::Detail, &[Char('c')], "c", A::Cancel, "cancel the run"),
    b(C::Detail, &[Char('r')], "r", A::Resume, "resume the run"),
    b(C::Detail, &[Char('R')], "R", A::Rename, "rename the run"),
    b(
        C::Detail,
        &[Char('L')],
        "L",
        A::Lock,
        "lock or unlock the run",
    ),
    b(C::Detail, &[Char('x')], "x", A::Delete, "delete the run"),
    b(
        C::Detail,
        &[Char('t')],
        "t",
        A::Attach,
        "attach to the interactive session (see Settings for the detach key)",
    ),
    b(
        C::Detail,
        &[Char('e')],
        "e",
        A::Edit,
        "edit the artifact in $EDITOR",
    ),
    b(
        C::Detail,
        &[Char('w')],
        "w",
        A::ContinueInWorktree,
        "new run in this run's worktree",
    ),
    b(
        C::Detail,
        &[Char('E')],
        "E",
        A::EndSession,
        "end the interactive session",
    ),
    b(C::Doctor, &[Char('r')], "r", A::Refresh, "check again"),
    b(C::NewRun, &[Char('s')], "s", A::StartRun, "start the run"),
    b(
        C::Detail,
        &[Char('m')],
        "m",
        A::OpenManual,
        "answer the step waiting on you",
    ),
    b(
        C::Manual,
        &[Char('a')],
        "a",
        A::Approve,
        "continue / approve",
    ),
    b(
        C::Manual,
        &[Char('b')],
        "b",
        A::SendBack,
        "send back (retry) with the note and comments",
    ),
    b(C::Manual, &[Char('X')], "X", A::AbortStep, "abort the run"),
    b(
        C::Manual,
        &[Char('i')],
        "i",
        A::EditNote,
        "write the note (Ctrl-e: $EDITOR)",
    ),
    b(
        C::Manual,
        &[Char('e')],
        "e",
        A::Edit,
        "edit the open artifact in $EDITOR",
    ),
    b(
        C::Manual,
        &[Char('o')],
        "o",
        A::Pager,
        "open the artifact in $PAGER",
    ),
    b(C::Workflows, &[Char('r')], "r", A::RunWorkflow, "run it"),
    b(
        C::Workflows,
        &[Char('e')],
        "e",
        A::Edit,
        "edit in $EDITOR; checked before it is saved",
    ),
    b(
        C::Workflows,
        &[Char('n')],
        "n",
        A::NewWorkflow,
        "new workflow in this repo",
    ),
    b(
        C::Workflows,
        &[Char('w')],
        "w",
        A::NewWorkspaceWorkflow,
        "new workflow for this workspace, kept in your user folder",
    ),
    b(
        C::Workflows,
        &[Char('N')],
        "N",
        A::NewGlobalWorkflow,
        "new global workflow",
    ),
    b(C::Workflows, &[Char('c')], "c", A::CloneWorkflow, "clone"),
    b(C::Workflows, &[Char('x')], "x", A::Delete, "delete"),
    b(
        C::Workflows,
        &[Char('o')],
        "o",
        A::Pager,
        "show the file in $PAGER",
    ),
    b(
        C::Workflows,
        &[Char('i')],
        "i",
        A::InitWorkspace,
        "set up this workspace (asks where)",
    ),
    b(C::Workflows, &[Ctrl('r')], "Ctrl-r", A::Refresh, "reload"),
    b(
        C::Settings,
        &[Code(KeyCode::Tab), Code(KeyCode::BackTab)],
        "Tab",
        A::NextPane,
        "next pane",
    ),
    b(
        C::Settings,
        &[Char('u')],
        "u",
        A::Inherit,
        "use the global value here",
    ),
    b(
        C::Settings,
        &[Char('P')],
        "P",
        A::Prune,
        "delete runs beyond the maximum now",
    ),
    b(
        C::Settings,
        &[Ctrl('r')],
        "Ctrl-r",
        A::Refresh,
        "reload; models are asked again",
    ),
];

/// What `key` does on `screen`; `goto` after a `g`.
pub fn action(screen: &Route, goto: bool, key: &KeyEvent) -> Option<Action> {
    let find = |ctx: Ctx| {
        BINDINGS
            .iter()
            .filter(|b| b.ctx == ctx)
            .find(|b| b.keys.iter().any(|k| k.matches(key)))
            .map(|b| b.action)
    };
    if goto {
        return find(Ctx::Goto);
    }
    find(Ctx::of(screen)).or_else(|| find(Ctx::Global))
}

/// The footer's hints for a screen: its own bindings, briefly.
/// The footer's hints in `width` columns: the screen's own keys in table
/// order, leaving out any that do not fit, then `? help` and `q back`,
/// which always show. `…` stands for the ones left out; `?` lists them.
pub fn hints(screen: &Route, width: usize) -> String {
    let own: Vec<String> = BINDINGS
        .iter()
        .filter(|b| b.ctx == Ctx::of(screen))
        .filter(|b| !matches!(b.action, A::Tab(1..)))
        .map(|b| {
            let label = if b.action == A::Tab(0) {
                "1-4"
            } else {
                b.label
            };
            let help = if b.action == A::Tab(0) {
                "tabs"
            } else {
                b.help
            };
            format!("{label} {help}")
        })
        .collect();
    const SEP: &str = "  ·  ";
    let cols = |s: &str| s.chars().count();
    let tail = ["? help", "q back"].join(SEP);
    let all: usize = own.iter().map(|h| cols(h) + cols(SEP)).sum();
    if all + cols(&tail) <= width {
        let mut parts = own;
        parts.push(tail);
        return parts.join(SEP);
    }
    // Some must go: those that do not fit, in order, keeping room for `…`.
    let mut used = cols(&tail) + cols("…") + cols(SEP);
    let mut parts: Vec<String> = Vec::new();
    for hint in own {
        if used + cols(&hint) + cols(SEP) <= width {
            used += cols(&hint) + cols(SEP);
            parts.push(hint);
        }
    }
    parts.push("…".into());
    parts.push(tail);
    parts.join(SEP)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A key means one thing per screen: never twice in one context, and a
    // screen never shadows a global key.
    #[test]
    fn no_key_is_bound_twice_where_it_applies() {
        let ctxs = [
            C::Goto,
            C::Workspaces,
            C::Runs,
            C::Detail,
            C::Doctor,
            C::NewRun,
            C::Manual,
            C::Workflows,
            C::Settings,
        ];
        for ctx in ctxs.into_iter().chain([C::Global]) {
            let scope = BINDINGS
                .iter()
                .filter(|b| {
                    b.ctx == ctx || (ctx != C::Global && ctx != C::Goto && b.ctx == C::Global)
                })
                .flat_map(|b| b.keys.iter().copied());
            let mut seen = Vec::new();
            for k in scope {
                assert!(!seen.contains(&k), "{k:?} bound twice in {ctx:?}");
                seen.push(k);
            }
        }
    }

    #[test]
    fn a_screen_key_wins_and_globals_still_work() {
        let o = KeyEvent::from(KeyCode::Char('o'));
        assert_eq!(action(&Route::Runs, false, &o), Some(A::Ongoing));
        assert_eq!(action(&Route::RunDetail, false, &o), Some(A::Pager));
        assert_eq!(action(&Route::Doctor, false, &o), None);
        let q = KeyEvent::from(KeyCode::Char('q'));
        assert_eq!(action(&Route::Doctor, false, &q), Some(A::Back));
        let w = KeyEvent::from(KeyCode::Char('w'));
        assert_eq!(action(&Route::Runs, true, &w), Some(A::GoWorkspaces));
        // Phase 2 moved these off e, a and r, which drive runs.
        let f = KeyEvent::from(KeyCode::Char('f'));
        assert_eq!(action(&Route::RunDetail, false, &f), Some(A::ErrorsOnly));
        let all = KeyEvent::from(KeyCode::Char('A'));
        assert_eq!(action(&Route::RunDetail, false, &all), Some(A::AllSteps));
        let ctrl_r = KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL);
        assert_eq!(action(&Route::RunDetail, false, &ctrl_r), Some(A::Refresh));
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(action(&Route::Runs, false, &ctrl_c), Some(A::Interrupt));
        let r = KeyEvent::from(KeyCode::Char('r'));
        assert_eq!(action(&Route::RunDetail, false, &r), Some(A::Resume));
        assert_eq!(action(&Route::Doctor, false, &r), Some(A::Refresh));
    }

    #[test]
    fn hints_fit_the_width_and_always_offer_help() {
        let wide = hints(&Route::RunDetail, 1000);
        assert!(!wide.contains('…'));
        let narrow = hints(&Route::RunDetail, 79);
        assert!(narrow.chars().count() <= 79, "{narrow}");
        assert!(narrow.starts_with("Tab switch pane"));
        // A long hint that does not fit leaves room for shorter ones after it.
        let runs = hints(&Route::Runs, 79);
        assert!(
            !runs.contains("m answer") && runs.contains("c cancel"),
            "{runs}"
        );
        assert!(narrow.ends_with("…  ·  ? help  ·  q back"), "{narrow}");
        assert_eq!(hints(&Route::RunDetail, 10), "…  ·  ? help  ·  q back");
    }

    #[test]
    fn alt_gr_keys_are_characters() {
        // Windows reports AltGr as Ctrl and Alt.
        let alt_gr = KeyModifiers::CONTROL | KeyModifiers::ALT;
        let help = KeyEvent::new(KeyCode::Char('?'), alt_gr);
        assert_eq!(action(&Route::Runs, false, &help), Some(A::Help));
        let r = KeyEvent::new(KeyCode::Char('r'), alt_gr);
        assert_ne!(action(&Route::RunDetail, false, &r), Some(A::Refresh));
    }
}
