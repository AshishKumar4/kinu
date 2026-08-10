/**
 * HTML → agent-ready markdown — the local fallback path for `web` fetch.
 *
 * The preferred path is server-side: a `fetch` with `Accept: text/markdown`
 * gets clean markdown from any Cloudflare-proxied zone (Markdown-for-Agents),
 * and cf-backend can route HTML through `env.AI.toMarkdown`. This module is the
 * dependency-free fallback that runs in any V8 isolate when neither is
 * available — a deliberately small readability+turndown substitute (no jsdom,
 * no turndown, both of which are too heavy for a Worker).
 *
 * It is intentionally lossy: scripts/styles/SVG and base64 images are dropped,
 * structural tags become markdown, everything else is flattened to text. Good
 * enough to feed an LLM; not a faithful renderer.
 */

/** Strip base64 data-URI images (and SVGs) — they are pure token noise.
 *  Mirrors hermes-agent clean_base64_images. */
export function stripBase64Images(text: string): string {
  return text
    .replace(/\(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+\)/g, '(image)')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+/g, '[image]')
    .replace(/data:[^;,]+;base64,[A-Za-z0-9+/=\s]{200,}/g, '[binary-data]');
}

const BLOCK_TAGS =
  'address|article|aside|blockquote|details|div|dl|dd|dt|fieldset|figcaption|figure|footer|form|header|hr|main|nav|ol|p|pre|section|table|tr|ul';

/** Decode the small set of HTML entities that survive tag stripping. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Convert an HTML string to a compact markdown-ish text suitable for an LLM. */
export function htmlToMarkdown(html: string): string {
  let s = html;

  // Drop non-content elements wholesale (content + tags).
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Headings → markdown.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl: string, inner: string) => {
    return `\n\n${'#'.repeat(Number(lvl))} ${stripTags(inner).trim()}\n\n`;
  });

  // Links → [text](href).
  s = s.replace(/<a\b[^>]*?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const text = stripTags(inner).trim();
    if (!text) return '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return text;
    return `[${text}](${href})`;
  });

  // List items.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `\n- ${stripTags(inner).trim()}`);
  // Table cells → space-separated.
  s = s.replace(/<\/td>\s*<td\b[^>]*>/gi, ' | ');
  s = s.replace(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner: string) => `${stripTags(inner).trim()} `);
  // Line breaks.
  s = s.replace(/<br\s*\/?>(?!\n)/gi, '\n');
  // Block boundaries → blank lines.
  s = s.replace(new RegExp(`</(?:${BLOCK_TAGS})>`, 'gi'), '\n\n');
  s = s.replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');

  s = stripTags(s);
  s = decodeEntities(s);
  s = stripBase64Images(s);

  // Collapse runaway whitespace.
  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/** True when the byte stream looks like HTML rather than already-clean text. */
export function looksLikeHtml(text: string, contentType?: string): boolean {
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('text/markdown') || ct.includes('text/plain')) return false;
    if (ct.includes('text/html') || ct.includes('application/xhtml')) return true;
  }
  return /<html[\s>]|<body[\s>]|<!doctype html/i.test(text.slice(0, 2000));
}
