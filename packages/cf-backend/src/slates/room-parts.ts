/**
 * A part's sealed content (docs/SLATE-SHARING-SECURITY.md §2.4): what a confined run returned, served from the app's
 * origin to the one session its ticket names, in a frame that runs no script and reaches no network. The slate's own
 * code, on its own host, cannot read it; the person sees it. What a run returns is the slate author's text, so its
 * markup is cut down to a fixed set of elements with no links, no media and no resources (`HTMLRewriter`), and the
 * headers forbid what the cut might miss. It stays in the cf closure: it is written against workerd's `HTMLRewriter`,
 * whose element attributes Bun's declaration types differently.
 */
import { escapeHtml, type JsonValue } from '@kinu.run/core';

/** Elements kept; any other is dropped, keeping its text. `script`, `style`, `template` and their kind go with their contents. */
const KEPT = new Set([
  'p', 'div', 'span', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'section', 'article', 'header', 'footer', 'figure', 'figcaption',
]);

/** Elements dropped with everything inside them. */
const GONE = 'script, style, template, noscript, iframe, object, embed, svg, math, link, meta, base, form, input, button, textarea, select, img, video, audio, source, picture, canvas';

/** Attributes kept on a kept element: none that styles or names anything; the page's own style is the part's look. */
const ATTRIBUTES = new Set(['colspan', 'rowspan']);

/**
 * No script, no form, no resource, no navigation away: the sandbox CSP plus `default-src 'none'`. Framed by the slate's
 * own page, itself framed by the app: every ancestor is checked, so both are named, exactly, and nothing else.
 */
function sealedHeaders(host: string | null) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'${host === null ? '' : ` ${host}`}; form-action 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
}

const PAGE_STYLE = '<style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#1f2937;background:transparent}pre{white-space:pre-wrap}</style>';

function document(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${PAGE_STYLE}</head><body>${body}</body></html>`;
}

/**
 * The part's content, or nothing at all when the session may not see it: a placeholder is the part frame's, not this.
 * `host` is the slate's own page's origin, which frames it.
 */
export async function sealedPart(value: JsonValue | null, host: string | null): Promise<Response> {
  const headers = sealedHeaders(host);

  if (value === null) return new Response(document(''), { status: 200, headers });

  if (typeof value !== 'string') return new Response(document(`<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`), { headers });

  const cut = new HTMLRewriter()
    .on(GONE, { element: (element) => { element.remove(); } })
    .on('*', {
      element(element) {
        if (!KEPT.has(element.tagName)) {
          element.removeAndKeepContent();

          return;
        }

        // Named first: workerd refuses an attribute removed while its attributes are being walked.
        const names = [...element.attributes].map(([name]) => name);

        for (const name of names) {
          if (!ATTRIBUTES.has(name)) element.removeAttribute(name);
        }
      },
    })
    .transform(new Response(value));

  return new Response(document(await cut.text()), { headers });
}
