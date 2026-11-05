/**
 * The design bar's Kumo switch (audit #27): Kumo's parts as Kinu restyles them, or as Kumo draws them. Kinu's restyle
 * is index.css's `!important` declarations on the classes its `ui/` wrappers put on Kumo's parts; "Kumo's own" takes
 * those declarations out of the page's stylesheets, and "as it ships" puts each back where it was. Review chrome only:
 * the product's CSS is never edited, so what the owner sees is exactly the difference those overrides make.
 */

/** The classes the `ui/` wrappers put on Kumo's parts, and the Kumo markup the stylesheet reaches into. */
const KUMO_PARTS = /\.p-select|\.p-popover|\.p-tooltip|data-tooltip-body|\.p-meter-|\.p-copy-field|\.p-composer-model|\.landing-tabs|\.p-background-sheet/u;

interface Taken {
  readonly style: CSSStyleDeclaration;
  readonly property: string;
  readonly value: string;
}

let taken: readonly Taken[] = [];

function* styleRules(rules: CSSRuleList): Generator<CSSStyleRule> {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      yield rule;
      yield* styleRules(rule.cssRules);
    } else if (rule instanceof CSSGroupingRule) yield* styleRules(rule.cssRules);
  }
}

function sheetRules(sheet: CSSStyleSheet): CSSRuleList | null {
  // A stylesheet from another origin cannot be read; none of Kinu's is one.
  return sheet.href === null || new URL(sheet.href).origin === location.origin ? sheet.cssRules : null;
}

/** Kumo's parts as Kumo draws them (`true`), or as Kinu restyles them. */
export function wearKumoOwn(own: boolean): void {
  if (!own) {
    for (const { style, property, value } of taken) style.setProperty(property, value, 'important');
    taken = [];

    return;
  }

  if (taken.length > 0) return;
  const found: Taken[] = [];

  for (const sheet of document.styleSheets) {
    const rules = sheetRules(sheet);

    if (rules === null) continue;

    for (const rule of styleRules(rules)) {
      if (!KUMO_PARTS.test(rule.selectorText)) continue;

      for (const property of rule.style) {
        if (rule.style.getPropertyPriority(property) !== 'important') continue;
        found.push({ style: rule.style, property, value: rule.style.getPropertyValue(property) });
      }
    }
  }

  for (const { style, property } of found) style.removeProperty(property);
  taken = found;
}
