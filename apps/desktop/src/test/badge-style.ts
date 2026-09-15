/**
 * Fluent v9 conveys a Badge's colour and size through hashed atomic CSS
 * classes (griffel), not data attributes — so a test that asks "is this badge
 * the yellow warning fill at 24px?" can't read it off the element directly.
 * This helper resolves the element's own classes against the rules griffel
 * injected into the document at render time, so assertions name the design
 * intent (`--colorPaletteYellowBackground3`, `height: 24px`) rather than a
 * hash that would change with every Fluent rebuild.
 */

/**
 * True when one of the element's own classes sets `property` to exactly
 * `value` (e.g. `hasInjectedStyle(badge, 'background-color', 'var(--colorPaletteYellowBackground3)')`).
 */
export function hasInjectedStyle(el: Element, property: string, value: string): boolean {
  const classes = Array.from(el.classList);
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin sheets throw; nothing of ours is in there.
      continue;
    }
    for (const rule of Array.from(rules)) {
      // Atomic griffel rules are single-class selectors (`.ffq97bm { … }`);
      // pseudo-element rules like `.r1iycov::after` don't match.
      const match = rule.cssText.match(/^\.([A-Za-z0-9_-]+)\s*\{\s*(.*?)\s*\}$/);
      if (!match || !classes.includes(match[1])) continue;
      for (const declaration of match[2].split(';')) {
        const [name, ...rest] = declaration.split(':');
        if (name.trim() === property && rest.join(':').trim() === value) return true;
      }
    }
  }
  return false;
}
