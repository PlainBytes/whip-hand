//! A paste on Windows: the console delivers it as key presses, not as one
//! event, so a multi-line paste would submit a one-line prompt at its first
//! line break and run the lines after it as keys. Keys that were all waiting
//! at once, with a line break among them, are taken as a paste instead.

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

/// The text of a burst of keys that reads as a paste: at least two presses,
/// a line break among them, and nothing but characters, Enter and Tab
/// (AltGr's characters come with Ctrl and Alt held). `None` for anything a
/// person could have typed, which stays keys.
pub fn from_burst(keys: &[KeyEvent]) -> Option<String> {
    let presses: Vec<&KeyEvent> = keys
        .iter()
        .filter(|k| k.kind != KeyEventKind::Release)
        .collect();
    if presses.len() < 2 || !presses.iter().any(|k| k.code == KeyCode::Enter) {
        return None;
    }
    let altgr = KeyModifiers::CONTROL | KeyModifiers::ALT;
    let mut text = String::new();
    for k in presses {
        let held = k.modifiers - KeyModifiers::SHIFT;
        match k.code {
            KeyCode::Char(c) if held.is_empty() || held == altgr => text.push(c),
            KeyCode::Enter if held.is_empty() => text.push('\n'),
            KeyCode::Tab if held.is_empty() => text.push('\t'),
            _ => return None,
        }
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use crossterm::event::KeyEventState;

    use super::*;

    fn press(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        }
    }

    fn typed(text: &str) -> Vec<KeyEvent> {
        text.chars()
            .flat_map(|c| {
                let code = match c {
                    '\n' => KeyCode::Enter,
                    '\t' => KeyCode::Tab,
                    c => KeyCode::Char(c),
                };
                let shift = if c.is_uppercase() {
                    KeyModifiers::SHIFT
                } else {
                    KeyModifiers::NONE
                };
                let down = press(code, shift);
                // The console reports key-ups too.
                let up = KeyEvent {
                    kind: KeyEventKind::Release,
                    ..down
                };
                [down, up]
            })
            .collect()
    }

    #[test]
    fn lines_waiting_at_once_are_a_paste() {
        assert_eq!(
            from_burst(&typed("First line\nsecond\tline")).as_deref(),
            Some("First line\nsecond\tline")
        );
        let mut altgr = typed("a\n");
        altgr.push(press(
            KeyCode::Char('@'),
            KeyModifiers::CONTROL | KeyModifiers::ALT,
        ));
        assert_eq!(from_burst(&altgr).as_deref(), Some("a\n@"));
    }

    #[test]
    fn what_a_person_types_stays_keys() {
        // Enter alone, keys without a line break, and a burst with a chord.
        assert_eq!(from_burst(&typed("\n")), None);
        assert_eq!(from_burst(&typed("jk")), None);
        let mut chord = typed("a\n");
        chord.push(press(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(from_burst(&chord), None);
        let mut arrow = typed("a\n");
        arrow.push(press(KeyCode::Up, KeyModifiers::NONE));
        assert_eq!(from_burst(&arrow), None);
    }
}
