import type { JsonValue } from '@kinu.run/core';

/**
 * What a person sees of a page an agent built, read without leaning on its markup: the visible text, and for each of
 * a set of names (teams, venues, plans) the parts of the page that name it and no other, with the controls a person
 * could press there. A part is read across, as a table row, a card or a list item is, and down, as a grid's column is
 * under its heading. Text no style hides but that lies past the page's sides is not seen: at chat width a person sees
 * it only by scrolling across. Text drawn on a canvas is not text and is not read.
 */

/** A part of a page that names one name and no other: what it says, and the labels of the controls in it. */
export type Region = { readonly text: string; readonly controls: readonly string[] };

/** A page as read once: all its visible text, and every region for each name asked about. */
export type Sight = { readonly text: string; readonly regions: Readonly<Record<string, readonly Region[]>> };

/** A page as {@link look} read it, and the control it was asked to find. */
export type Looked = { readonly sight: Sight; readonly control: Element | null };

/** Which control {@link look} hands back: the one in a region of `name` whose label `label` matches (a pattern's
 *  source, in any case), or the region's only control when `label` is null. */
export type Press = { readonly name: string; readonly label: string | null };

/**
 * Runs in the page, so it is whole: nothing it uses is defined outside it. Visible text is every text node no style
 * hides and that lies within the page's sides, outside scripts and a select's closed list, plus what text fields hold.
 * A name is matched whole and in any case. From each text node that names it alone, its row is the widest element
 * that names no other, and its column what lies below it within the sides of the block that holds it, when that names
 * no other. A control is what a person can press: an interactive element, or the outermost element showing a pointer;
 * one inside another is the one pressed, the click reaching both. `control` is the one `press` names, null when none or
 * more than one would do.
 */
export function look(names: readonly string[], press: Press | null): Looked {
  const sides = document.documentElement.clientWidth;
  const hidden = 'script,style,noscript,template,select,option,datalist';
  const interactive = 'button,a[href],input:not([type=hidden]),textarea,label,summary,[role=button],[role=link],[role=radio],[role=option],[role=checkbox],[role=menuitem],[role=tab],[tabindex]:not([tabindex="-1"])';
  const boxes = new Map<Node, DOMRect>();

  // Seen: no style hides it, it takes room, and it lies within the page's sides. `styled` is the element whose style
  // decides, the node itself or a text's parent.
  const seen = (node: Element | Text, styled: Element): boolean => {
    const range = document.createRange();

    range.selectNodeContents(node);
    const box = node instanceof Element ? node.getBoundingClientRect() : range.getBoundingClientRect();

    boxes.set(node, box);

    return styled.closest(hidden) === null && styled.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      && box.width > 0 && box.left >= -1 && box.right <= sides + 1;
  };

  const texts: (Text | HTMLInputElement | HTMLTextAreaElement)[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && (node.textContent ?? '').trim() !== '' && node.parentElement !== null && seen(node, node.parentElement)) texts.push(node);
  }

  for (const field of document.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type]),input[type=text],input[type=number],textarea')) {
    if (field.value !== '' && seen(field, field)) texts.push(field);
  }

  const pressable = [...document.body.querySelectorAll('*')].filter((element) => seen(element, element) && (element.matches(interactive)
    || (getComputedStyle(element).cursor === 'pointer' && (element.parentElement === null || getComputedStyle(element.parentElement).cursor !== 'pointer'))));

  const controls = pressable.filter((element) => !pressable.some((other) => other !== element && element.contains(other))).map((element) => ({
    element,
    label: (element.getAttribute('aria-label') ?? (element instanceof HTMLElement ? element.innerText : '')).trim()
      || (element instanceof HTMLInputElement ? element.value : '') || (element.getAttribute('title') ?? ''),
  }));

  const said = (node: Text | HTMLInputElement | HTMLTextAreaElement): string => (node instanceof Text ? node.textContent ?? '' : node.value).trim();
  const textWhere = (inside: (node: Node) => boolean): string => texts.filter(inside).map(said).join(' ');
  const patterns = new Map(names.map((name) => [name, new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')]));
  const others = (name: string, text: string): boolean => names.some((other) => other !== name && (patterns.get(other)?.test(text) ?? false));
  const regions: Record<string, Region[]> = {};
  const pressing = new Set<Element>();

  const below = (cell: Element) => (each: Node): boolean => {
    const column = cell.getBoundingClientRect();
    const box = boxes.get(each);

    return box !== undefined && box.left + box.width / 2 >= column.left && box.left + box.width / 2 <= column.right && box.top >= column.top - 1;
  };

  for (const name of names) {
    const rows = new Set<Element>();
    const columns = new Set<Element>();

    for (const node of texts) {
      const start = node instanceof Text ? node.parentElement : node;

      if (start === null || !(patterns.get(name)?.test(said(node)) ?? false) || others(name, said(node))) continue;
      let row = start;

      while (row.parentElement !== null && row.parentElement !== document.body && !others(name, textWhere((each) => row.parentElement?.contains(each) ?? false))) {
        row = row.parentElement;
      }

      rows.add(row);
      let cell = start;

      while (cell.parentElement !== null && ['inline', 'contents'].includes(getComputedStyle(cell).display)) cell = cell.parentElement;
      columns.add(cell);
    }

    const parts = [...[...rows].map((row) => (each: Node) => row.contains(each)), ...[...columns].map(below)];

    regions[name] = parts.flatMap((inside) => {
      const text = textWhere(inside);

      if (others(name, text)) return [];
      const held = controls.filter((control) => inside(control.element));

      if (press !== null && press.name === name) {
        for (const control of held) if (press.label === null ? held.length === 1 : new RegExp(press.label, 'i').test(control.label)) pressing.add(control.element);
      }

      return [{ text, controls: held.map((control) => control.label) }];
    });
  }

  return { sight: { text: textWhere(() => true), regions }, control: pressing.size === 1 ? [...pressing][0] ?? null : null };
}

/** A reading as a check's evidence: its text and each name's parts, cut short. */
export function sightEvidence(sight: Sight): JsonValue {
  return {
    text: sight.text.slice(0, 600),
    regions: Object.fromEntries(Object.entries(sight.regions).map(([name, regions]) => [name, regions.map((region) => ({
      text: region.text.slice(0, 300), controls: [...region.controls],
    }))])),
  };
}

/** Whether `text` shows `value` (dollars, milliseconds, a count) to the cent, whatever its sign and digit grouping:
 *  `$1,641.00`, `1641`, `−141.00` and `(141.00)` all show their magnitude. */
export function shows(text: string, value: number): boolean {
  return [...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)]
    .some((match) => Math.abs(Number(match[0].replaceAll(',', '')) - Math.abs(value)) < 0.005);
}
