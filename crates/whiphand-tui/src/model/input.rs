//! A small text editor: the dialogs' one-line prompts, and the new-run
//! form's and the manual screen's longer fields.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// What a key did to an [`Input`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edit {
    /// The text or the cursor moved.
    Changed,
    /// Enter on a one-line input.
    Submit,
    /// Esc: the caller decides whether that keeps or drops the text.
    Leave,
    /// Not an editing key.
    Ignored,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Input {
    /// Never empty.
    lines: Vec<String>,
    /// Line, then character (not byte) within it.
    row: usize,
    col: usize,
    pub multiline: bool,
}

impl Input {
    pub fn new(text: &str, multiline: bool) -> Input {
        let mut input = Input {
            multiline,
            ..Input::default()
        };
        input.set(text);
        input
    }

    /// Replaces the text; the cursor goes to its end.
    pub fn set(&mut self, text: &str) {
        self.lines = if self.multiline {
            text.split('\n').map(str::to_string).collect()
        } else {
            vec![text.replace('\n', " ")]
        };
        self.row = self.lines.len() - 1;
        self.col = self.lines[self.row].chars().count();
    }

    pub fn text(&self) -> String {
        self.lines.join("\n")
    }

    pub fn is_blank(&self) -> bool {
        self.lines.iter().all(|l| l.trim().is_empty())
    }

    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    /// Where the cursor is: line, and character within it.
    pub fn cursor(&self) -> (usize, usize) {
        (self.row, self.col)
    }

    fn byte(&self, col: usize) -> usize {
        let line = &self.lines[self.row];
        line.char_indices().nth(col).map_or(line.len(), |(i, _)| i)
    }

    fn line_len(&self) -> usize {
        self.lines[self.row].chars().count()
    }

    pub fn key(&mut self, key: &KeyEvent) -> Edit {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match key.code {
            KeyCode::Esc => return Edit::Leave,
            KeyCode::Enter if self.multiline => {
                let at = self.byte(self.col);
                let rest = self.lines[self.row].split_off(at);
                self.row += 1;
                self.lines.insert(self.row, rest);
                self.col = 0;
            }
            KeyCode::Enter => return Edit::Submit,
            KeyCode::Char('u') if ctrl => {
                let at = self.byte(self.col);
                self.lines[self.row].replace_range(..at, "");
                self.col = 0;
            }
            KeyCode::Char('a') if ctrl => self.col = 0,
            KeyCode::Char(_) if ctrl => return Edit::Ignored,
            KeyCode::Char(c) => {
                let at = self.byte(self.col);
                self.lines[self.row].insert(at, c);
                self.col += 1;
            }
            KeyCode::Backspace if self.col > 0 => {
                self.col -= 1;
                let at = self.byte(self.col);
                self.lines[self.row].remove(at);
            }
            KeyCode::Backspace if self.row > 0 => {
                let line = self.lines.remove(self.row);
                self.row -= 1;
                self.col = self.line_len();
                self.lines[self.row].push_str(&line);
            }
            KeyCode::Delete if self.col < self.line_len() => {
                let at = self.byte(self.col);
                self.lines[self.row].remove(at);
            }
            KeyCode::Delete if self.row + 1 < self.lines.len() => {
                let next = self.lines.remove(self.row + 1);
                self.lines[self.row].push_str(&next);
            }
            KeyCode::Left if self.col > 0 => self.col -= 1,
            KeyCode::Left if self.row > 0 => {
                self.row -= 1;
                self.col = self.line_len();
            }
            KeyCode::Right if self.col < self.line_len() => self.col += 1,
            KeyCode::Right if self.row + 1 < self.lines.len() => {
                self.row += 1;
                self.col = 0;
            }
            KeyCode::Up if self.row > 0 => {
                self.row -= 1;
                self.col = self.col.min(self.line_len());
            }
            KeyCode::Down if self.row + 1 < self.lines.len() => {
                self.row += 1;
                self.col = self.col.min(self.line_len());
            }
            KeyCode::Home => self.col = 0,
            KeyCode::End => self.col = self.line_len(),
            KeyCode::Backspace
            | KeyCode::Delete
            | KeyCode::Left
            | KeyCode::Right
            | KeyCode::Up
            | KeyCode::Down => {}
            _ => return Edit::Ignored,
        }
        Edit::Changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(input: &mut Input, code: KeyCode) -> Edit {
        input.key(&KeyEvent::from(code))
    }

    fn typed(input: &mut Input, s: &str) {
        for c in s.chars() {
            press(input, KeyCode::Char(c));
        }
    }

    #[test]
    fn one_line_edits_by_character_and_submits_on_enter() {
        let mut i = Input::new("héllo", false);
        press(&mut i, KeyCode::Left);
        press(&mut i, KeyCode::Left);
        press(&mut i, KeyCode::Backspace);
        assert_eq!(i.text(), "hélo");
        typed(&mut i, "€");
        assert_eq!(i.text(), "hé€lo");
        assert_eq!(press(&mut i, KeyCode::Enter), Edit::Submit);
        assert_eq!(press(&mut i, KeyCode::Esc), Edit::Leave);
    }

    #[test]
    fn several_lines_split_and_join() {
        let mut i = Input::new("ab", true);
        press(&mut i, KeyCode::Left);
        assert_eq!(press(&mut i, KeyCode::Enter), Edit::Changed);
        assert_eq!(i.lines(), ["a", "b"]);
        assert_eq!(i.cursor(), (1, 0));
        press(&mut i, KeyCode::Backspace);
        assert_eq!(i.text(), "ab");
        press(&mut i, KeyCode::End);
        press(&mut i, KeyCode::Enter);
        typed(&mut i, "c");
        press(&mut i, KeyCode::Up);
        assert_eq!(i.cursor(), (0, 1));
        press(&mut i, KeyCode::End);
        press(&mut i, KeyCode::Delete);
        assert_eq!(i.text(), "abc");
    }

    #[test]
    fn ctrl_u_clears_to_the_cursor_and_blank_means_whitespace_only() {
        let mut i = Input::new("name", false);
        let ctrl_u = KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL);
        assert_eq!(i.key(&ctrl_u), Edit::Changed);
        assert_eq!(i.text(), "");
        typed(&mut i, "  ");
        assert!(i.is_blank());
        let ctrl_x = KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL);
        assert_eq!(i.key(&ctrl_x), Edit::Ignored);
    }

    #[test]
    fn a_one_line_input_flattens_newlines() {
        assert_eq!(Input::new("a\nb", false).text(), "a b");
        assert_eq!(Input::new("a\nb", true).lines(), ["a", "b"]);
    }
}
