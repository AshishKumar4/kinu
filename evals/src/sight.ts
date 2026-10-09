import type { JsonValue } from '@kinu.run/core';

/**
 * What a person sees of a page an agent built, read without leaning on its markup: the visible text, and for each of
 * a set of names (teams, venues, plans, hours) the parts of the page that belong to it, with the controls a person
 * could press there. A part is read across, as a table row, a card or a list item is, and down, as a grid's column or a
 * chart's bar is under its label. Text that is hidden, cut off by what holds it, or past the page's sides is not seen:
 * at chat width a person sees it only by scrolling across, if at all. Text drawn on a canvas is not text and is not read.
 */

/** A part of a page that belongs to one name: what it says, and the labels of the controls in it. */
type ReadRegion = { text: string; controls: string[]; columns?: Readonly<Record<string, string>>; occurrence?: number };

export type Region = Readonly<ReadRegion>;

/** A page as read once: all its visible text, and every region for each name asked about. */
export type Sight = { readonly text: string; readonly regions: Readonly<Record<string, readonly Region[]>> };

/** A page as {@link look} read it, and the control it was asked to find. */
export type Looked = { readonly sight: Sight; readonly control: Element | null };

/** Which control {@link look} hands back: the one in a region of `name` whose label `label` matches (a pattern's
 *  source, in any case), or the region's only control when `label` is null. */
export type Press = { readonly name: string; readonly label: string | null };

/**
 * Runs in the page, so it is whole: nothing it uses is defined outside it.
 *
 * SEEN: a text node, or a text field's value, that no style hides and that lies wholly inside the page's sides and
 * inside every ancestor that cuts off what overflows it.
 *
 * A NAME'S LABEL: the deepest element whose seen text names it (whole, in any case, across however many text nodes),
 * names no other, and says little else: at most `LABEL_LETTERS` letters besides the name. A heading, a cell, a legend.
 * Copy that mentions a name in passing ("everything in Team, plus SSO") is no label, so it neither starts a part nor
 * stops another name's part from growing over it.
 *
 * A NAME'S PARTS: its row, the widest element around its label that holds no other name's label; and its column, what
 * lies under or over the label's cell within the table, grid or drawing that holds it, when no other name's label is
 * there. A control is what a person can press, an interactive element or the outermost element showing a pointer; one
 * inside another is the one pressed, the click reaching both. `control` is the one `press` names, null when none or
 * more than one would do.
 */
export function look(names: readonly string[], press: Press | null): Looked {
  const LABEL_LETTERS = 16;
  const sides = document.documentElement.clientWidth;
  const hidden = 'script,style,noscript,template,select,option,datalist';
  const interactive = 'button,a[href],input:not([type=hidden]),textarea,label,summary,[role=button],[role=link],[role=radio],[role=option],[role=checkbox],[role=menuitem],[role=tab],[tabindex]:not([tabindex="-1"])';
  const boxes = new Map<Node, DOMRect>();

  // `styled` is the element whose style decides: the node itself, or a text's parent.
  const seen = (node: Element | Text, styled: Element): boolean => {
    const range = document.createRange();

    range.selectNodeContents(node);
    const box = node instanceof Element ? node.getBoundingClientRect() : range.getBoundingClientRect();

    boxes.set(node, box);

    if (styled.closest(hidden) !== null || !styled.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;

    if (box.width <= 0 || box.height <= 0 || box.left < -1 || box.right > sides + 1) return false;

    // A text is cut off by its own element too; an element, by what holds it.
    for (let holder = node instanceof Element ? styled.parentElement : styled; holder !== null; holder = holder.parentElement) {
      const style = getComputedStyle(holder), edge = holder.getBoundingClientRect();
      const cuts = (overflow: string): boolean => overflow === 'hidden' || overflow === 'clip';

      if (cuts(style.overflowX) && (box.left < edge.left - 1 || box.right > edge.right + 1)) return false;

      if (cuts(style.overflowY) && (box.top < edge.top - 1 || box.bottom > edge.bottom + 1)) return false;
    }

    return true;
  };

  type Said = Text | HTMLInputElement | HTMLTextAreaElement;

  const texts: Said[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && (node.textContent ?? '').trim() !== '' && node.parentElement !== null && seen(node, node.parentElement)) texts.push(node);
  }

  for (const field of document.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type]),input[type=text],input[type=number],textarea')) {
    if (field.value !== '' && seen(field, field)) texts.push(field);
  }

  const said = (node: Said): string => (node instanceof Text ? node.textContent ?? '' : node.value).trim();
  // Fields were collected after the text nodes: put every piece back in the order a person reads the page.
  texts.sort((left, right) => (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING) === 0 ? 1 : -1);
  const saying = (nodes: readonly Said[]): string => nodes.map(said).join(' ');
  // Every element holding seen text: the only ones that can label a name.
  const holding = new Set<Element>();

  for (const node of texts) {
    for (let holder = node instanceof Text ? node.parentElement : node; holder !== null && !holding.has(holder); holder = holder.parentElement) holding.add(holder);
  }

  // What an element reads as, its inline pieces run together as a person reads them (`innerText`), so a name split
  // across text nodes ("<b>Ced</b>ar House") is still the name. Asked only of elements holding seen text.
  const read = new Map<Element, string>();

  const textIn = (element: Element): string => {
    const known = read.get(element);

    if (known !== undefined) return known;
    const text = element instanceof HTMLElement ? element.innerText : element.textContent ?? '';

    read.set(element, text);

    return text;
  };

  const patterns = new Map(names.map((name) => [name, new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')]));
  const naming = (name: string, text: string): boolean => patterns.get(name)?.test(text) ?? false;

  const labels = new Map(names.map((name) => [name, [...holding].filter((element) => {
    const text = textIn(element);

    return naming(name, text) && !names.some((other) => other !== name && naming(other, text))
      && text.replace(patterns.get(name) ?? '', '').replace(/[^\p{L}]/gu, '').length <= LABEL_LETTERS
      && ![...element.children].some((child) => naming(name, textIn(child)));
  })]));

  const othersIn = (name: string, holds: (element: Element) => boolean): boolean =>
    names.some((other) => other !== name && (labels.get(other) ?? []).some(holds));

  const pressable = [...document.body.querySelectorAll('*')].filter((element) => seen(element, element) && (element.matches(interactive)
    || (getComputedStyle(element).cursor === 'pointer' && (element.parentElement === null || getComputedStyle(element.parentElement).cursor !== 'pointer'))));

  const controls = pressable.filter((element) => !pressable.some((other) => other !== element && element.contains(other))).map((element) => ({
    element,
    label: (element.getAttribute('aria-label') ?? (element instanceof HTMLElement ? element.innerText : '')).trim()
      || (element instanceof HTMLInputElement ? element.value : '') || (element.getAttribute('title') ?? ''),
  }));

  // What lies in the column under or over `cell`, within the table, grid or drawing holding it; null when none does.
  const columnOf = (cell: Element): ((node: Node) => boolean) | null => {
    let holder = cell.parentElement;

    while (holder !== null && holder !== document.body && !holder.matches('table,svg') && !['grid', 'inline-grid', 'flex', 'inline-flex'].includes(getComputedStyle(holder).display)) {
      holder = holder.parentElement;
    }

    // A flex chart can put its bars and axis labels in separate rows under one drawing, rather than in one grid.
    if (holder !== null && ['flex', 'inline-flex'].includes(getComputedStyle(holder).display)) holder = holder.parentElement;

    if (holder === null || holder === document.body) return null;
    const across = cell.getBoundingClientRect(), group = holder.getBoundingClientRect();

    return (node) => {
      const box = boxes.get(node) ?? (node instanceof Element ? node.getBoundingClientRect() : undefined);
      const middle = box === undefined ? NaN : box.left + box.width / 2;

      return box !== undefined && middle >= across.left && middle <= across.right && box.top >= group.top - 1 && box.bottom <= group.bottom + 1;
    };
  };

  const regions: Record<string, Region[]> = {};
  const pressing = new Set<Element>();

  const columnsOf = (row: Element) => {
    const table = row.closest('table');

    if (!row.matches('tr') || table === null) return {};
    const columns: Record<string, string> = {};
    const headers = [...((table.querySelector('thead tr:last-child') ?? table.querySelector('tr'))?.children ?? [])];

    for (const [index, cell] of [...row.children].entries()) {
      const header = headers[index];

      if (header !== undefined && header.matches('th, [role="columnheader"]')) columns[textIn(header).trim()] = saying(texts.filter((node) => cell.contains(node)));
    }

    return columns;
  };

  for (const name of names) {
    const parts: { inside: (node: Node) => boolean; occurrence: number }[] = [];
    const rows = new Map<Element, number>();

    const occurrenceOf = (row: Element): number => {
      const occurrence = rows.get(row) ?? rows.size;

      rows.set(row, occurrence);

      return occurrence;
    };

    const columns: Record<string, string> = {};

    for (const label of labels.get(name) ?? []) {
      let row = label;

      while (row.parentElement !== null && row.parentElement !== document.body && !othersIn(name, (other) => row.parentElement?.contains(other) ?? false)) {
        row = row.parentElement;
      }

      const occurrence = occurrenceOf(row);
      parts.push({ inside: (node) => row.contains(node), occurrence });
      Object.assign(columns, columnsOf(row));

      let cell = label;

      while (cell.parentElement !== null && ['inline', 'contents'].includes(getComputedStyle(cell).display)) cell = cell.parentElement;
      const column = columnOf(cell);

      if (column !== null && !othersIn(name, column)) parts.push({ inside: column, occurrence });
    }

    const readings: { text: Said[]; controls: Element[] }[] = [];
    regions[name] = parts.flatMap(({ inside, occurrence }) => {
      const held = controls.filter((control) => inside(control.element));
      const text = texts.filter(inside);
      const elements = held.map((control) => control.element);

      // A row and a column over the same nodes are one reading; identical copy in separate treatments stays separate.
      if (readings.some((reading) => reading.text.length === text.length && reading.text.every((node, index) => node === text[index])
        && reading.controls.length === elements.length && reading.controls.every((node, index) => node === elements[index]))) return [];
      readings.push({ text, controls: elements });

      if (press !== null && press.name === name) {
        for (const control of held) if (press.label === null ? held.length === 1 : new RegExp(press.label, 'i').test(control.label)) pressing.add(control.element);
      }

      const region: ReadRegion = { text: saying(text), controls: held.map((control) => control.label), occurrence };

      if (Object.keys(columns).length > 0) region.columns = columns;

      return [region];
    });
  }

  return { sight: { text: saying(texts), regions }, control: pressing.size === 1 ? [...pressing][0] ?? null : null };
}

/** A reading as a check's evidence: its text and each name's parts, cut short. */
export function sightEvidence(sight: Sight): JsonValue {
  return {
    text: sight.text.slice(0, 600),
    regions: Object.fromEntries(Object.entries(sight.regions).map(([name, regions]) => [name, regions.map((region) => {
      const evidence: ReadRegion = { text: region.text.slice(0, 300), controls: [...region.controls] };

      if (region.columns !== undefined) evidence.columns = region.columns;

      if (region.occurrence !== undefined) evidence.occurrence = region.occurrence;

      return evidence;
    })])),
  };
}

/** Whether `text` shows `value` (dollars, milliseconds, a count) to the cent, whatever its sign and digit grouping:
 *  `$1,641.00`, `1641`, `−141.00` and `(141.00)` all show their magnitude. */
export function shows(text: string, value: number): boolean {
  return [...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)]
    .some((match) => Math.abs(Number(match[0].replaceAll(',', '')) - Math.abs(value)) < 0.005);
}
