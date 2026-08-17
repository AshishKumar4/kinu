#!/usr/bin/env bun
/**
 * Computed-style gate — every design token must resolve in a browser.
 *
 * `--radius` was declared nowhere but `[data-proteus-plan-review]` while
 * `@theme inline` mapped Tailwind's whole radius scale onto
 * `calc(var(--radius) …)`. A `var()` with no declaration and no fallback makes
 * the entire declaration invalid at computed-value time, so `border-radius`
 * silently fell back to `0px` — at 191 call sites, Kumo's own compiled
 * components included. It shipped. It was valid CSS, the bundle built clean,
 * `tsc`, `oxlint`, the anti-slop rule set and 4,530 tests all passed, and the
 * owner found it by looking at the product.
 *
 * Nothing in the repo could have caught it, because every instrument reads the
 * SOURCE and the defect lives in the CASCADE. So this asks the engine.
 *
 * ## What it checks
 *
 * For every CSS rule in every loaded stylesheet whose declarations reference
 * `var(--x)` with no fallback, on every element the rule actually matches: the
 * computed value of `--x` must be non-empty. That is the browser's own answer
 * to "does this token exist here", asked at the scope where it is used.
 *
 * ## Why not a resolver in TypeScript
 *
 * `packages/cf-backend/tests/unit-radius-scale.test.ts` walks the custom-property
 * graph in the source and requires each radius to end at a length. It is a good
 * test and it is not this. It re-implements the cascade, and it enumerates the
 * nine tokens it knows about (`RUNGS`, `ROLES`) — so it locks the tokens someone
 * thought of, in a model of the cascade someone wrote. This enumerates nothing:
 * the token list is DISCOVERED from the stylesheets the page actually loaded,
 * which includes Tailwind's generated utilities and Kumo's compiled CSS, neither
 * of which is in this repo's source at all. The two answer different questions
 * and the browser's is the one the owner sees.
 *
 * ## Scope
 *
 * `@property`-registered tokens (Tailwind's `--tw-*`) have declared initial
 * values and resolve everywhere, so they cost nothing to include. A `var()`
 * WITH a fallback is legal by design and is skipped — the fallback is the
 * author saying the token is optional.
 *
 *   bun scripts/computed-style.ts            # every gallery frame
 *   bun scripts/computed-style.ts chat forks # named frames only
 */

import { withGallery } from './gallery-harness.ts';

/** Every frame `gallery.tsx` renders. Between them they mount each surface at
 *  least once, which is what makes "every rule that matched an element" a
 *  meaningful denominator rather than whatever the default frame happens to
 *  show. */
const FRAMES = [
  'shell', 'chat', 'chatempty', 'toolcalls', 'streaming', 'modal', 'home', 'tabs', 'markdown',
  'views', 'viewfail', 'releases', 'work', 'workempty', 'approvals', 'environment', 'supervise',
  'settings', 'forks', 'forkmerge', 'forkfull',
] as const;

export interface Unresolved {
  /** The custom property that computed to nothing. */
  readonly token: string;
  /** The rule that referenced it. */
  readonly selector: string;
  /** The declaration that referenced it, e.g. `border-radius`. */
  readonly property: string;
  /** A matched element, as `tag.class`, so the failure is findable. */
  readonly element: string;
  readonly frame: string;
}

/** What one page yielded: the defects, and how many token resolutions were
 *  performed to find them. The denominator is part of the verdict. `ok` with a
 *  denominator of zero is `tool-construction`'s `0/0, score null` reported as
 *  100% — this repo has already shipped that mistake once. */
export interface PageAudit {
  readonly findings: readonly Omit<Unresolved, 'frame'>[];
  readonly checked: number;
}

/**
 * Runs INSIDE the page. Returns every (token, rule, element) where the browser
 * resolves the token to nothing, and the number of resolutions attempted.
 *
 * Written as one self-contained function body because puppeteer serialises it
 * across the CDP boundary: it can close over nothing from this module.
 *
 * Exported so the gate's own test can seed a defect into a real rendered page
 * and watch this report it, without a hook in the gate for tests to pull.
 */
export function auditPage(): PageAudit {
  const out: Omit<Unresolved, 'frame'>[] = [];
  const seen = new Set<string>();
  let checked = 0;

  /** `var(--x)` with NO fallback. A fallback means the author declared the
   *  token optional, and an absent optional token is not a defect. */
  const BARE_VAR = /var\(\s*(--[\w-]+)\s*\)/g;

  const rulesOf = (sheet: CSSStyleSheet): CSSRule[] => {
    const flat: CSSRule[] = [];
    const walk = (list: CSSRuleList): void => {
      for (const rule of list) {
        flat.push(rule);
        // `@layer`, `@media`, `@supports`, `@container` and (with CSS nesting)
        // `CSSStyleRule` all group. Tailwind v4 emits everything inside
        // `@layer`, so a walk that does not descend sees almost nothing.
        if (rule instanceof CSSGroupingRule) walk(rule.cssRules);
      }
    };
    try {
      walk(sheet.cssRules);
    } catch {
      // A cross-origin stylesheet throws on cssRules. The gallery loads none,
      // but a font CDN added later must not turn this gate into a crash.
    }
    return flat;
  };

  for (const sheet of document.styleSheets) {
    for (const rule of rulesOf(sheet)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      // Declarations are read off `cssText`, NOT by iterating `rule.style`.
      // Chrome expands a shorthand into its longhands there, and a longhand
      // holding a pending-substitution value serialises as the empty string —
      // so `border-radius: calc(var(--radius) - 2px)`, the exact shipped
      // defect, appears as four properties whose values contain no `var(` at
      // all. Iterating the declaration object cannot see this bug.
      const text = rule.style.cssText;
      if (!text.includes('var(')) continue;
      const declarations = [...text.matchAll(/(?:^|;)\s*([-\w]+)\s*:\s*([^;]*)/g)]
        .filter(([, , value]) => value!.includes('var('))
        .map(([, property, value]) => [property!, value!] satisfies [string, string]);
      if (declarations.length === 0) continue;

      let matched: Element[];
      try {
        matched = [...document.querySelectorAll(rule.selectorText)];
      } catch {
        continue; // `::-webkit-…`, `:has()` variants Chrome will not query
      }
      if (matched.length === 0) continue;

      // One element per rule is enough: the token either exists at that scope
      // or it does not, and reporting 400 identical rows helps nobody.
      const element = matched[0]!;
      const computed = getComputedStyle(element);
      const label = element.tagName.toLowerCase()
        + (element.classList.length > 0 ? `.${[...element.classList].slice(0, 2).join('.')}` : '');

      for (const [property, value] of declarations) {
        for (const [, token] of value.matchAll(BARE_VAR)) {
          checked += 1;
          if (computed.getPropertyValue(token).trim() !== '') continue;
          const key = `${token}|${rule.selectorText}|${property}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ token, selector: rule.selectorText, property, element: label });
        }
      }
    }
  }
  return { findings: out, checked };
}

export interface Audit {
  readonly found: readonly Unresolved[];
  /** Total token resolutions performed across every frame. */
  readonly checked: number;
}

export async function audit(frames: readonly string[]): Promise<Audit> {
  return withGallery(async ({ browser, origin }) => {
    const found: Unresolved[] = [];
    let checked = 0;
    for (const frame of frames) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 1100 });
      await page.goto(`${origin}/gallery.html?frame=${frame}`, { waitUntil: 'networkidle0' });
      // React renders after the mock RPC stubs resolve; the mock is async.
      await Bun.sleep(600);
      const pageAudit = await page.evaluate(auditPage);
      checked += pageAudit.checked;
      for (const hit of pageAudit.findings) found.push({ ...hit, frame });
      await page.close();
    }
    return { found, checked };
  });
}

/** Collapse to one row per (token, property): the same missing token under 30
 *  selectors is one defect, and the frame list is what tells you how much of
 *  the product it takes down. */
export function summarise(found: readonly Unresolved[]): string[] {
  const byToken = new Map<string, Unresolved[]>();
  for (const hit of found) {
    const key = `${hit.token} in ${hit.property}`;
    const bucket = byToken.get(key) ?? [];
    bucket.push(hit);
    byToken.set(key, bucket);
  }
  return [...byToken.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, hits]) => {
    const frames = [...new Set(hits.map((h) => h.frame))].sort();
    return `  ${key} — unresolved at ${hits.length} rule(s) across ${frames.length} frame(s): `
      + `${frames.join(', ')}\n      e.g. \`${hits[0]!.selector}\` on <${hits[0]!.element}>`;
  });
}

if (import.meta.main) {
  const named = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const frames = named.length > 0 ? named : FRAMES;
  const { found, checked } = await audit(frames);
  // A denominator of zero means the page never rendered or the selectors never
  // matched, and silence would read as a pass. It is a failure.
  if (checked === 0) {
    console.error(`computed-style: resolved 0 tokens across ${frames.length} frame(s) — nothing was measured`);
    process.exit(1);
  }
  if (found.length === 0) {
    console.log(`computed-style: ok — ${checked} token resolutions across ${frames.length} frames`);
    process.exit(0);
  }
  console.error(`computed-style: ${found.length} of ${checked} token reference(s) unresolved\n`);
  for (const line of summarise(found)) console.error(line);
  process.exit(1);
}
