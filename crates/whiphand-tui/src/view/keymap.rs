//! Every key binding, in one table: `update` dispatches through it, and the
//! `?` overlay and the footer hints are drawn from it (docs/tui-plan.md,
//! section 6). Phase 2 and 3 keys are not bound until their actions exist.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::model::Route;

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
}

impl Ctx {
    pub fn of(route: &Route) -> Ctx {
        match route {
            Route::Workspaces => Ctx::Workspaces,
            Route::Runs => Ctx::Runs,
            Route::RunDetail => Ctx::Detail,
            Route::Doctor => Ctx::Doctor,
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
        let ctrl = ev.modifiers.contains(KeyModifiers::CONTROL);
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
        "go to a screen (then w, r or d)",
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
    b(C::Goto, &[Char('d')], "g d", A::GoDoctor, "doctor"),
    b(C::Workspaces, &[Char('p')], "p", A::Pin, "pin or unpin"),
    b(C::Runs, &[Char('/')], "/", A::Filter, "filter"),
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
        &[Char('E')],
        "E",
        A::EndSession,
        "end the interactive session",
    ),
    b(C::Doctor, &[Char('r')], "r", A::Refresh, "check again"),
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
pub fn hints(screen: &Route) -> String {
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
    let mut parts = own;
    parts.push("? help".into());
    parts.push("q back".into());
    parts.join("  ·  ")
}

#[cfg(test)]
mod tests {
    use super::*;

    // A key means one thing per screen: never twice in one context, and a
    // screen never shadows a global key.
    #[test]
    fn no_key_is_bound_twice_where_it_applies() {
        let ctxs = [C::Goto, C::Workspaces, C::Runs, C::Detail, C::Doctor];
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
}
