import type { JsonValue } from '@kinu.run/core';

/**
 * What a person sees of a page an agent built, read without leaning on its markup: the visible text, and for each of
 * a set of names (teams, venues, plans) the part of the page that names it and no other, with the controls a person
 * could press there. A table row, a card, a list item and a chart's labelled bar all read the same way. A layout that
 * never sets one name apart from the rest (a transposed table) has no part for it, which a check reports as the name
 * not shown. Text drawn on a canvas is not text and is not read.
 */

/** The part of a page that names one name and no other: what it says, the labels of the controls in it, and whether
 *  it runs past the page's sides, where a person cannot see all of it without scrolling across. */
export type Region = { readonly text: string; readonly controls: readonly string[]; readonly clipped: boolean };

/** A page as read once: all its visible text, and every region for each name asked about. */
export type Sight = { readonly text: string; readonly regions: Readonly<Record<string, readonly Region[]>> };

/** A page as {@link look} read it, and the control it was asked to find. */
export type Looked = { readonly sight: Sight; readonly control: Element | null };

/** Which control {@link look} hands back: the one in a region of `name` whose label `label` matches (a pattern's
 *  source, in any case), or the region's only control when `label` is null. */
export type Press = { readonly name: string; readonly label: string | null };

/**
 * Runs in the page, so it is whole: nothing it uses is defined outside it. Visible text is every text node no style
 * hides, outside scripts and a select's closed list, plus what text fields hold. A name is matched whole and in any
 * case. Its region grows from each text node that names it alone, up to the widest element that still names no
 * other: a row is found from its cell, a card from its heading. A control is what a person can press: an interactive
 * element, or the outermost element showing a pointer. `control` is the one `press` names, null when none or more
 * than one would do.
 */
export function look(names: readonly string[], press: Press | null): Looked {
  const shown = (element: Element): boolean => element.closest('script,style,noscript,template,select,option,datalist') === null
    && element.checkVisibility({ opacityProperty: true, visibilityProperty: true });

  const textOf = (root: Element): string => {
    const parts: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';

      if (text !== '' && node.parentElement !== null && shown(node.parentElement)) parts.push(text);
    }

    for (const field of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type]),input[type=text],input[type=number],textarea')) {
      if (field.value !== '' && shown(field)) parts.push(field.value);
    }

    return parts.join(' ');
  };

  const patterns = new Map(names.map((name) => [name, new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')]));
  const others = (name: string, text: string): boolean => names.some((other) => other !== name && (patterns.get(other)?.test(text) ?? false));
  const interactive = 'button,a[href],input:not([type=hidden]),textarea,label,summary,[role=button],[role=link],[role=radio],[role=option],[role=checkbox],[role=menuitem],[role=tab],[tabindex]:not([tabindex="-1"])';
  const regions: Record<string, Region[]> = {};
  const pressing: Element[] = [];

  for (const name of names) {
    const found = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      let region = node.parentElement;

      if (region === null || !shown(region) || !(patterns.get(name)?.test(text) ?? false) || others(name, text)) continue;

      while (region.parentElement !== null && region.parentElement !== document.body && !others(name, textOf(region.parentElement))) {
        region = region.parentElement;
      }

      found.add(region);
    }

    regions[name] = [...found].map((region) => {
      const controls = [region, ...region.querySelectorAll('*')]
        .filter((element) => shown(element) && (element.matches(interactive) || (getComputedStyle(element).cursor === 'pointer'
          && (element.parentElement === null || getComputedStyle(element.parentElement).cursor !== 'pointer'))))
        // A label and the field it wraps are one control.
        .filter((element, _, all) => !all.some((other) => other !== element && other.matches('label') && other.contains(element)))
        .map((element) => ({
          element,
          label: (element.getAttribute('aria-label') ?? (element instanceof HTMLElement ? element.innerText : '')).trim()
            || (element instanceof HTMLInputElement ? element.value : '') || (element.getAttribute('title') ?? ''),
        }));

      if (press !== null && press.name === name) {
        pressing.push(...controls.filter((control) => press.label === null ? controls.length === 1 : new RegExp(press.label, 'i').test(control.label))
          .map((control) => control.element));
      }

      const box = region.getBoundingClientRect();

      return {
        text: textOf(region), controls: controls.map((control) => control.label),
        clipped: box.left < -1 || box.right > document.documentElement.clientWidth + 1,
      };
    });
  }

  return { sight: { text: textOf(document.body), regions }, control: pressing.length === 1 ? pressing[0] ?? null : null };
}

/** A reading as a check's evidence: its text and each name's parts, cut short. */
export function sightEvidence(sight: Sight): JsonValue {
  return {
    text: sight.text.slice(0, 600),
    regions: Object.fromEntries(Object.entries(sight.regions).map(([name, regions]) => [name, regions.map((region) => ({
      text: region.text.slice(0, 300), controls: [...region.controls], clipped: region.clipped,
    }))])),
  };
}

/** Whether `text` shows `value` (dollars, milliseconds, a count) to the cent, whatever its sign and digit grouping:
 *  `$1,641.00`, `1641`, `−141.00` and `(141.00)` all show their magnitude. */
export function shows(text: string, value: number): boolean {
  return [...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)]
    .some((match) => Math.abs(Number(match[0].replaceAll(',', '')) - Math.abs(value)) < 0.005);
}
