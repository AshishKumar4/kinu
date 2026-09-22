/**
 * HTML → agent-ready markdown: the dependency-free, intentionally lossy fallback for `web` fetch when
 * neither `Accept: text/markdown` nor `env.AI.toMarkdown` is available. Not a faithful renderer.
 */

/** Strip base64 data-URI images and SVGs (token noise). Mirrors hermes-agent clean_base64_images. */
export function stripBase64Images(text: string): string {
  return text
    .replace(/\(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+\)/g, '(image)')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{32,}/g, '[image]')
    .replace(/data:[^;,]+;base64,[A-Za-z0-9+/=\s]{200,}/g, '[binary-data]');
}

const BLOCK_TAGS =
  'address|article|aside|blockquote|details|div|dl|dd|dt|fieldset|figcaption|figure|footer|form|header|hr|main|nav|ol|p|pre|section|table|tr|ul';

/** Decode the small set of HTML entities that survive tag stripping. */
export function decodeEntities(s: string): string {
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

  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl: string, inner: string) => {
    return `\n\n${'#'.repeat(Number(lvl))} ${stripTags(inner).trim()}\n\n`;
  });

  s = s.replace(/<a\b[^>]*?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const text = stripTags(inner).trim();

    if (!text) return '';

    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return text;

    return `[${text}](${href})`;
  });

  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `\n- ${stripTags(inner).trim()}`);
  s = s.replace(/<\/td>\s*<td\b[^>]*>/gi, ' | ');
  s = s.replace(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner: string) => `${stripTags(inner).trim()} `);
  s = s.replace(/<br\s*\/?>(?!\n)/gi, '\n');
  s = s.replace(new RegExp(`</(?:${BLOCK_TAGS})>`, 'gi'), '\n\n');
  s = s.replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');

  s = stripTags(s);
  s = decodeEntities(s);
  s = stripBase64Images(s);

  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s;
}

export function stripTags(html: string): string {
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
