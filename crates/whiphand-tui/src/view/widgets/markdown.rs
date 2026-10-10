//! Markdown as styled terminal text: headings, emphasis, lists, quotes and
//! code. Mermaid, images and tables are left to the desktop's viewers; a
//! table's cells still read, one row per line.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};

struct Writer {
    lines: Vec<Line<'static>>,
    spans: Vec<Span<'static>>,
    styles: Vec<Style>,
    /// One entry per open list: the next item number, or `None` for bullets.
    lists: Vec<Option<u64>>,
    quote: usize,
    in_code: bool,
}

impl Writer {
    fn style(&self) -> Style {
        self.styles
            .iter()
            .fold(Style::new(), |acc, s| acc.patch(*s))
    }

    fn prefix(&self) -> String {
        "│ ".repeat(self.quote)
    }

    fn flush(&mut self) {
        if self.spans.is_empty() {
            return;
        }
        let mut spans = Vec::new();
        if self.quote > 0 {
            spans.push(Span::styled(
                self.prefix(),
                Style::new().add_modifier(Modifier::DIM),
            ));
        }
        spans.append(&mut self.spans);
        self.lines.push(Line::from(spans));
    }

    fn blank(&mut self) {
        self.flush();
        if self.lines.last().is_some_and(|l| !l.spans.is_empty()) {
            self.lines.push(Line::default());
        }
    }

    fn text(&mut self, text: &str) {
        let style = self.style();
        if self.in_code {
            for (i, line) in text.split('\n').enumerate() {
                if i > 0 {
                    self.flush();
                }
                if !line.is_empty() {
                    self.spans.push(Span::styled(format!("    {line}"), style));
                }
            }
            return;
        }
        self.spans.push(Span::styled(text.to_string(), style));
    }
}

fn heading_style(level: HeadingLevel) -> Style {
    let base = Style::new().add_modifier(Modifier::BOLD);
    match level {
        HeadingLevel::H1 => base.fg(Color::Cyan).add_modifier(Modifier::UNDERLINED),
        HeadingLevel::H2 => base.fg(Color::Cyan),
        _ => base,
    }
}

pub fn render(source: &str) -> Text<'static> {
    let mut w = Writer {
        lines: Vec::new(),
        spans: Vec::new(),
        styles: Vec::new(),
        lists: Vec::new(),
        quote: 0,
        in_code: false,
    };
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_TABLES;
    for event in Parser::new_ext(source, options) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    w.blank();
                    let hashes = "#".repeat(level as usize);
                    w.styles.push(heading_style(level));
                    w.text(&format!("{hashes} "));
                }
                Tag::Paragraph => {}
                Tag::BlockQuote(_) => {
                    w.blank();
                    w.quote += 1;
                }
                Tag::CodeBlock(kind) => {
                    w.blank();
                    if let CodeBlockKind::Fenced(lang) = kind
                        && !lang.is_empty()
                    {
                        w.spans.push(Span::styled(
                            format!("    ┌ {lang}"),
                            Style::new().add_modifier(Modifier::DIM),
                        ));
                        w.flush();
                    }
                    w.in_code = true;
                    w.styles.push(Style::new().fg(Color::Yellow));
                }
                Tag::List(start) => {
                    w.flush();
                    w.lists.push(start);
                }
                Tag::Item => {
                    w.flush();
                    let depth = w.lists.len().saturating_sub(1);
                    let marker = match w.lists.last_mut() {
                        Some(Some(n)) => {
                            let m = format!("{n}. ");
                            *n += 1;
                            m
                        }
                        _ => "• ".into(),
                    };
                    w.spans
                        .push(Span::raw(format!("{}{marker}", "  ".repeat(depth))));
                }
                Tag::Emphasis => w.styles.push(Style::new().add_modifier(Modifier::ITALIC)),
                Tag::Strong => w.styles.push(Style::new().add_modifier(Modifier::BOLD)),
                Tag::Strikethrough => w
                    .styles
                    .push(Style::new().add_modifier(Modifier::CROSSED_OUT)),
                Tag::Link { .. } => w.styles.push(
                    Style::new()
                        .fg(Color::Blue)
                        .add_modifier(Modifier::UNDERLINED),
                ),
                Tag::Image { .. } => w.text("[image: "),
                Tag::TableRow | Tag::TableHead => w.flush(),
                Tag::TableCell => w.text("│ "),
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Heading(_) => {
                    w.styles.pop();
                    w.blank();
                }
                TagEnd::Paragraph => {
                    if w.lists.is_empty() {
                        w.blank();
                    } else {
                        w.flush();
                    }
                }
                TagEnd::BlockQuote(_) => {
                    w.flush();
                    w.quote = w.quote.saturating_sub(1);
                    w.blank();
                }
                TagEnd::CodeBlock => {
                    w.in_code = false;
                    w.styles.pop();
                    w.blank();
                }
                TagEnd::List(_) => {
                    w.flush();
                    w.lists.pop();
                    if w.lists.is_empty() {
                        w.blank();
                    }
                }
                TagEnd::Item => w.flush(),
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link => {
                    w.styles.pop();
                }
                TagEnd::Image => w.text("]"),
                TagEnd::TableHead | TagEnd::TableRow => w.flush(),
                TagEnd::Table => w.blank(),
                _ => {}
            },
            Event::Text(t) => w.text(&t),
            Event::Code(t) => {
                let style = w.style().fg(Color::Yellow);
                w.spans.push(Span::styled(format!("`{t}`"), style));
            }
            Event::SoftBreak => w.text(" "),
            Event::HardBreak => w.flush(),
            Event::Rule => {
                w.blank();
                w.spans.push(Span::styled(
                    "─".repeat(40),
                    Style::new().add_modifier(Modifier::DIM),
                ));
                w.blank();
            }
            Event::TaskListMarker(done) => w.text(if done { "[x] " } else { "[ ] " }),
            Event::Html(t) | Event::InlineHtml(t) => w.text(&t),
            _ => {}
        }
    }
    w.flush();
    while w.lines.last().is_some_and(|l| l.spans.is_empty()) {
        w.lines.pop();
    }
    Text::from(w.lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(text: &Text) -> Vec<String> {
        text.lines
            .iter()
            .map(|l| l.spans.iter().map(|s| s.content.as_ref()).collect())
            .collect()
    }

    #[test]
    fn renders_the_shapes_a_plan_uses() {
        let md = "# Plan\n\nShip *it* with `cargo`.\n\n- one\n- two\n  1. nested\n\n```rust\nfn main() {}\n```\n\n> quoted\n";
        assert_eq!(
            plain(&render(md)),
            [
                "# Plan",
                "",
                "Ship it with `cargo`.",
                "",
                "• one",
                "• two",
                "  1. nested",
                "",
                "    ┌ rust",
                "    fn main() {}",
                "",
                "│ quoted",
            ]
        );
    }
}
