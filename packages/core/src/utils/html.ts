/**
 * An HTML page read by an HTML parser (`HTMLRewriter`, which workerd and Bun provide) as an agent reads it: the web
 * fetch's fallback when no converter answers, a mail's HTML part, a slate answer's title. Intentionally lossy; not a
 * faithful renderer.
 */

import { decodeEntities, HTML_ENTITIES } from './text';

/** `value` as text inside HTML, or inside a quoted attribute's value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Elements whose text is no part of the page a reader sees. The head's other elements hold no text. */
const UNSEEN: ReadonlySet<string> = new Set(['script', 'style', 'noscript', 'template', 'svg']);

/** Elements that stand as blocks: a line before, a paragraph's break after. */
const BLOCKS: ReadonlySet<string> = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dd', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'header', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
]);

/** What a page says: its title, and its text as compact markdown. Each is empty when the page has none. */
export interface HtmlReading {
  readonly title: string;
  readonly markdown: string;
}

/** An `<a>`'s target as a link a reader follows: none for an anchor on the page or a script. */
function linkTarget(href: string | null): string | null {
  return href === null || href === '' || href.startsWith('#') || /^javascript:/iu.test(href) ? null : href;
}

/**
 * A page's title, and its text with headings, links, list items, table cells and blocks in markdown, what no reader
 * sees (scripts, styles, an SVG's own titles) aside. The parser hands text over as written, so each character
 * reference is decoded once, over the whole: `&amp;lt;` reads `&lt;`.
 */
export async function readHtml(html: string): Promise<HtmlReading> {
  const out: string[] = [];
  let title = '';
  let titled = false;
  let inTitle = false;
  let unseen = 0;
  let firstCell = true;

  const rewriter = new HTMLRewriter().on('*', {
    element(element) {
      const tag = element.tagName.toLowerCase();

      if (UNSEEN.has(tag)) {
        unseen += 1;
        element.onEndTag(() => { unseen -= 1; });

        return;
      }

      if (unseen > 0) return;

      if (tag === 'title') {
        // The document's one title: the first, outside an SVG.
        inTitle = !titled;
        titled = true;
        element.onEndTag(() => { inTitle = false; });

        return;
      }

      const heading = /^h([1-6])$/u.exec(tag)?.[1];
      const start = out.length;

      if (heading !== undefined) {
        out.push(`\n\n${'#'.repeat(Number(heading))} `);
        element.onEndTag(() => { out.push('\n\n'); });
      } else if (tag === 'a') {
        const href = linkTarget(element.getAttribute('href'));

        // The link's own text, once it has ended: a link with none says nothing.
        element.onEndTag(() => {
          const text = out.splice(start).join('').replace(/\s+/gu, ' ').trim();

          if (text !== '') out.push(href === null ? text : `[${text}](${href})`);
        });
      } else if (tag === 'li') out.push('\n- ');
      else if (tag === 'td' || tag === 'th') {
        if (!firstCell) out.push(' | ');
        firstCell = false;
      } else if (tag === 'br' || tag === 'hr') out.push('\n');
      else if (BLOCKS.has(tag)) {
        if (tag === 'tr') firstCell = true;
        out.push('\n');
        element.onEndTag(() => { out.push('\n\n'); });
      }
    },
  }).onDocument({
    text(chunk) {
      if (inTitle) title += chunk.text;
      else if (unseen === 0) out.push(chunk.text);
    },
  });

  await rewriter.transform(new Response(html)).arrayBuffer();

  const markdown = decodeEntities(out.join(''), HTML_ENTITIES)
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  return { title: decodeEntities(title, HTML_ENTITIES).replace(/\s+/gu, ' ').trim(), markdown };
}
