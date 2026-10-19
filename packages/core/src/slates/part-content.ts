/**
 * A personal part's content (docs/SLATE-SHARING-NIMBUS.md §3): what its confined run returned, as the one document its
 * viewer's part frame draws in a frame that runs no script (`sandbox` with no tokens) and reaches no network. What a run
 * returns is the slate author's markup, so it is cut down to a fixed set of elements with no links, no media and no
 * resources (`HTMLRewriter`, which workerd and Bun both provide), and the document's own policy forbids what the cut
 * might miss.
 */

/**
 * Elements kept; any other is dropped, keeping its text. `script`, `style`, `template` and their kind go with their
 * contents, and so does every element whose inside the parser reads as text: unwrapped, that text would be read as markup
 * once the frame parses the cut again.
 */
const KEPT = new Set([
  'p', 'div', 'span', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'section', 'article', 'header', 'footer', 'figure', 'figcaption',
]);

/** Elements dropped with everything inside them: what runs, loads or takes input, and what holds raw text. */
const GONE = 'script, style, template, noscript, iframe, object, embed, svg, math, link, meta, base, form, input, button, textarea, select, img, video, audio, source, picture, canvas, '
  + 'xmp, plaintext, title, noembed, noframes';

/** Attributes kept on a kept element, and then only as a small number: none that styles, names or links anything. */
const SPANS = ['colspan', 'rowspan'] as const;

/** Kept elements that take no end tag. */
const VOID = new Set(['br', 'hr']);

const PAGE_STYLE = '<style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#1f2937;background:transparent}pre{white-space:pre-wrap}</style>';

/** No resource of any kind and no form, only the document's own inline style: a `srcdoc` frame keeps it as written. */
const SEALED_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'">`;

function document(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${SEALED_POLICY}${PAGE_STYLE}</head><body>${body}</body></html>`;
}

/** A part's markup as its viewer's frame draws it: cut, inside its sealed document. */
export async function sealedPartDocument(html: string): Promise<string> {
  const cut = new HTMLRewriter()
    .on(GONE, { element: (element) => { element.remove(); } })
    .on('*', {
      // A kept element is written anew, its tag and its spans only: none of the author's attributes is ever copied.
      element(element) {
        const tag = element.tagName;

        if (KEPT.has(tag)) {
          const spans = SPANS.flatMap((name) => {
            const value = element.getAttribute(name);

            return value !== null && /^\d{1,3}$/u.test(value) ? [` ${name}="${value}"`] : [];
          }).join('');

          element.before(`<${tag}${spans}>`, { html: true });

          if (!VOID.has(tag)) element.after(`</${tag}>`, { html: true });
        }

        element.removeAndKeepContent();
      },
    })
    .transform(new Response(html));

  return document(await cut.text());
}
