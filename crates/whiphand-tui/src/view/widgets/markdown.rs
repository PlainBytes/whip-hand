//! Markdown as styled terminal text: headings, emphasis, lists, quotes,
//! code and tables, rendered so it reads as a document rather than source.
//! Mermaid and images are left to the desktop's viewers.

use pulldown_cmark::{
    Alignment, CodeBlockKind, Event, HeadingLevel, LinkType, Options, Parser, Tag, TagEnd,
};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};

type Cell = Vec<Span<'static>>;

/// A table being buffered until `TagEnd::Table`, when column widths are known.
struct Table {
    aligns: Vec<Alignment>,
    /// The header row first.
    rows: Vec<Vec<Cell>>,
    row: Vec<Cell>,
}

struct List {
    /// The next item number, or `None` for bullets.
    next: Option<u64>,
    /// The previous item held paragraphs, so a blank line separates the next.
    loose_prev: bool,
}

struct Item {
    /// Width of the marker; continuation lines indent by this much.
    width: usize,
    /// Quote depth the item was opened at.
    quote: usize,
    /// Paragraphs, quotes and code blocks started in this item.
    blocks: usize,
    paragraphs: usize,
}

struct Writer {
    lines: Vec<Line<'static>>,
    spans: Vec<Span<'static>>,
    styles: Vec<Style>,
    lists: Vec<List>,
    items: Vec<Item>,
    /// The pending line starts with the innermost item's marker.
    item_first: bool,
    /// Open links: destination, and where their text starts in `spans`.
    links: Vec<(String, usize)>,
    table: Option<Table>,
    quote: usize,
    in_code: bool,
}

impl Writer {
    fn style(&self) -> Style {
        self.styles
            .iter()
            .fold(Style::new(), |acc, s| acc.patch(*s))
    }

    fn quote_span(depth: usize) -> Option<Span<'static>> {
        (depth > 0)
            .then(|| Span::styled("│ ".repeat(depth), Style::new().add_modifier(Modifier::DIM)))
    }

    fn flush(&mut self) {
        if self.spans.is_empty() {
            return;
        }
        let first = std::mem::take(&mut self.item_first);
        let enclosing = self.items.len() - usize::from(first && !self.items.is_empty());
        let indent: usize = self.items[..enclosing].iter().map(|i| i.width).sum();
        let outer = self
            .items
            .first()
            .map_or(self.quote, |i| i.quote.min(self.quote));
        let mut spans = Vec::new();
        spans.extend(Self::quote_span(outer));
        if indent > 0 {
            spans.push(Span::raw(" ".repeat(indent)));
        }
        spans.extend(Self::quote_span(self.quote - outer));
        spans.append(&mut self.spans);
        self.lines.push(Line::from(spans));
    }

    fn blank(&mut self) {
        self.flush();
        if self.lines.last().is_some_and(|l| !l.spans.is_empty()) {
            self.lines.push(Line::default());
        }
    }

    /// Counts a block starting in the innermost item, separating a second
    /// paragraph from the first.
    fn item_block(&mut self, paragraph: bool) {
        let Some(item) = self.items.last_mut() else {
            return;
        };
        let separate = paragraph && item.blocks > 0;
        item.blocks += 1;
        item.paragraphs += usize::from(paragraph);
        if separate {
            self.blank();
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

    fn end_link(&mut self, kind: LinkType) {
        self.styles.pop();
        let Some((url, start)) = self.links.pop() else {
            return;
        };
        let text: String = self.spans[start..]
            .iter()
            .map(|s| s.content.as_ref())
            .collect();
        let bare = matches!(kind, LinkType::Autolink | LinkType::Email);
        if !bare && !url.is_empty() && url != text {
            self.spans.push(Span::styled(
                format!(" ({url})"),
                Style::new().add_modifier(Modifier::DIM),
            ));
        }
    }

    fn end_table(&mut self) {
        let Some(table) = self.table.take() else {
            return;
        };
        self.flush();
        let cols = table.rows.iter().map(Vec::len).max().unwrap_or(0);
        let width = |cell: &Cell| -> usize { cell.iter().map(|s| s.content.chars().count()).sum() };
        let mut widths = vec![0; cols];
        for row in &table.rows {
            for (i, cell) in row.iter().enumerate() {
                widths[i] = widths[i].max(width(cell));
            }
        }
        let sep = || Span::styled(" │ ", Style::new().add_modifier(Modifier::DIM));
        for (r, row) in table.rows.iter().enumerate() {
            for (i, w) in widths.iter().enumerate() {
                if i > 0 {
                    self.spans.push(sep());
                }
                let empty = Cell::new();
                let cell = row.get(i).unwrap_or(&empty);
                let pad = w - width(cell);
                let (left, right) = match table.aligns.get(i) {
                    Some(Alignment::Right) => (pad, 0),
                    Some(Alignment::Center) => (pad / 2, pad - pad / 2),
                    _ => (0, pad),
                };
                // Padding past the last column would only trail invisibly.
                let right = if i + 1 == cols { 0 } else { right };
                if left > 0 {
                    self.spans.push(Span::raw(" ".repeat(left)));
                }
                for span in cell {
                    let style = if r == 0 {
                        span.style.add_modifier(Modifier::BOLD)
                    } else {
                        span.style
                    };
                    self.spans.push(Span::styled(span.content.clone(), style));
                }
                if right > 0 {
                    self.spans.push(Span::raw(" ".repeat(right)));
                }
            }
            self.flush();
            if r == 0 {
                let rule = widths
                    .iter()
                    .map(|w| "─".repeat(*w))
                    .collect::<Vec<_>>()
                    .join("─┼─");
                self.spans
                    .push(Span::styled(rule, Style::new().add_modifier(Modifier::DIM)));
                self.flush();
            }
        }
        self.blank();
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
        items: Vec::new(),
        item_first: false,
        links: Vec::new(),
        table: None,
        quote: 0,
        in_code: false,
    };
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_TABLES;
    let mut link_kinds = Vec::new();
    for event in Parser::new_ext(source, options) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    w.blank();
                    w.styles.push(heading_style(level));
                }
                Tag::Paragraph => w.item_block(true),
                Tag::BlockQuote(_) => {
                    w.blank();
                    w.item_block(false);
                    w.quote += 1;
                }
                Tag::CodeBlock(kind) => {
                    w.blank();
                    w.item_block(false);
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
                    w.lists.push(List {
                        next: start,
                        loose_prev: false,
                    });
                }
                Tag::Item => {
                    w.flush();
                    if w.lists.last().is_some_and(|l| l.loose_prev) {
                        w.blank();
                    }
                    let marker = match w.lists.last_mut() {
                        Some(List { next: Some(n), .. }) => {
                            let m = format!("{n}. ");
                            *n += 1;
                            m
                        }
                        _ => "• ".into(),
                    };
                    w.items.push(Item {
                        width: marker.chars().count(),
                        quote: w.quote,
                        blocks: 0,
                        paragraphs: 0,
                    });
                    w.item_first = true;
                    w.spans.push(Span::raw(marker));
                }
                Tag::Emphasis => w.styles.push(Style::new().add_modifier(Modifier::ITALIC)),
                Tag::Strong => w.styles.push(Style::new().add_modifier(Modifier::BOLD)),
                Tag::Strikethrough => w
                    .styles
                    .push(Style::new().add_modifier(Modifier::CROSSED_OUT)),
                Tag::Link {
                    link_type,
                    dest_url,
                    ..
                } => {
                    w.styles.push(
                        Style::new()
                            .fg(Color::Blue)
                            .add_modifier(Modifier::UNDERLINED),
                    );
                    w.links.push((dest_url.to_string(), w.spans.len()));
                    link_kinds.push(link_type);
                }
                Tag::Image { .. } => w.text("[image: "),
                Tag::Table(aligns) => {
                    w.flush();
                    w.table = Some(Table {
                        aligns,
                        rows: Vec::new(),
                        row: Vec::new(),
                    });
                }
                Tag::TableHead | Tag::TableRow | Tag::TableCell => {}
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
                TagEnd::Item => {
                    w.flush();
                    let loose = w.items.pop().is_some_and(|i| i.paragraphs > 0);
                    if let Some(list) = w.lists.last_mut() {
                        list.loose_prev = loose;
                    }
                }
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                    w.styles.pop();
                }
                TagEnd::Link => {
                    let kind = link_kinds.pop().unwrap_or(LinkType::Inline);
                    w.end_link(kind);
                }
                TagEnd::Image => w.text("]"),
                TagEnd::TableCell => {
                    let cell = std::mem::take(&mut w.spans);
                    if let Some(t) = w.table.as_mut() {
                        t.row.push(cell);
                    }
                }
                TagEnd::TableHead | TagEnd::TableRow => {
                    if let Some(t) = w.table.as_mut() {
                        let row = std::mem::take(&mut t.row);
                        t.rows.push(row);
                    }
                }
                TagEnd::Table => w.end_table(),
                _ => {}
            },
            Event::Text(t) => w.text(&t),
            Event::Code(t) => {
                let style = w.style().fg(Color::Yellow);
                w.spans.push(Span::styled(t.to_string(), style));
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
            Event::TaskListMarker(done) => w.text(if done { "☑ " } else { "☐ " }),
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
                "Plan",
                "",
                "Ship it with cargo.",
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

    fn span<'a>(text: &'a Text<'static>, line: usize, content: &str) -> &'a Span<'static> {
        text.lines[line]
            .spans
            .iter()
            .find(|s| s.content == content)
            .unwrap_or_else(|| panic!("no span {content:?} on line {line}"))
    }

    #[test]
    fn headings_drop_their_markers_and_style_by_level() {
        let t = render("# Plan\n\n## Steps\n\n### Deep\n");
        assert_eq!(plain(&t), ["Plan", "", "Steps", "", "Deep"]);
        let h1 = span(&t, 0, "Plan").style;
        assert!(
            h1.add_modifier
                .contains(Modifier::BOLD | Modifier::UNDERLINED)
        );
        assert_eq!(h1.fg, Some(Color::Cyan));
        let h2 = span(&t, 2, "Steps").style;
        assert!(h2.add_modifier.contains(Modifier::BOLD));
        assert!(!h2.add_modifier.contains(Modifier::UNDERLINED));
        assert_eq!(h2.fg, Some(Color::Cyan));
        let h3 = span(&t, 4, "Deep").style;
        assert!(h3.add_modifier.contains(Modifier::BOLD));
        assert_eq!(h3.fg, None);
    }

    #[test]
    fn inline_code_has_no_backticks_but_stays_styled() {
        let t = render("run `cargo` now");
        assert_eq!(plain(&t), ["run cargo now"]);
        assert_eq!(span(&t, 0, "cargo").style.fg, Some(Color::Yellow));
    }

    #[test]
    fn links_show_a_dimmed_url_unless_it_repeats_the_text() {
        let t = render("[docs](https://x.y)");
        assert_eq!(plain(&t), ["docs (https://x.y)"]);
        assert!(
            span(&t, 0, " (https://x.y)")
                .style
                .add_modifier
                .contains(Modifier::DIM)
        );
        assert_eq!(span(&t, 0, "docs").style.fg, Some(Color::Blue));
        assert_eq!(plain(&render("<https://x.y>")), ["https://x.y"]);
        assert_eq!(
            plain(&render("[https://x.y](https://x.y)")),
            ["https://x.y"]
        );
        assert_eq!(plain(&render("[nowhere]()")), ["nowhere"]);
    }

    #[test]
    fn images_show_their_alt_text() {
        assert_eq!(plain(&render("![a chart](c.png)")), ["[image: a chart]"]);
    }

    #[test]
    fn tables_align_their_columns_under_a_ruled_header() {
        let md = "| Name | Qty | Note |\n|:-----|----:|:----:|\n| `a` | 1 | x |\n| longer | 1000 | yy |\n";
        let t = render(md);
        assert_eq!(
            plain(&t),
            [
                "Name   │  Qty │ Note",
                "───────┼──────┼─────",
                "a      │    1 │  x",
                "longer │ 1000 │  yy",
            ]
        );
        assert!(
            span(&t, 0, "Name")
                .style
                .add_modifier
                .contains(Modifier::BOLD)
        );
        assert!(!span(&t, 2, "1").style.add_modifier.contains(Modifier::BOLD));
        assert_eq!(span(&t, 2, "a").style.fg, Some(Color::Yellow));
    }

    #[test]
    fn a_list_items_continuation_lines_up_under_its_text() {
        let md = "- first\n\n  second\n\n  ```\n  code\n  ```\n- next\n\n1. one\n\n   more\n";
        assert_eq!(
            plain(&render(md)),
            [
                "• first",
                "",
                "  second",
                "",
                "      code",
                "",
                "• next",
                "",
                "1. one",
                "",
                "   more",
            ]
        );
    }

    #[test]
    fn tight_lists_have_no_blank_lines_and_loose_ones_keep_one() {
        assert_eq!(plain(&render("- a\n- b\n")), ["• a", "• b"]);
        assert_eq!(plain(&render("- a\n\n- b\n")), ["• a", "", "• b"]);
    }

    #[test]
    fn task_markers_are_boxes() {
        assert_eq!(plain(&render("- [ ] a\n- [x] b\n")), ["• ☐ a", "• ☑ b"]);
    }

    #[test]
    fn no_trailing_blank_lines() {
        let t = render("para\n\n---\n\n| a |\n|---|\n| b |\n");
        assert!(t.lines.last().is_some_and(|l| !l.spans.is_empty()));
    }
}
