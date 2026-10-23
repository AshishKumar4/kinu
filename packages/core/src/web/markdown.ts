/**
 * HTML → agent-ready markdown: the dependency-free, intentionally lossy fallback for `web` fetch when
 * neither `Accept: text/markdown` nor `env.AI.toMarkdown` is available. Not a faithful renderer.
 */

import { readHtml } from '../utils/html';

/** Strip base64 data-URI images and SVGs (token noise). Mirrors hermes-agent clean_base64_images. */
export function stripBase64Images(text: string): string {
  return text
    .replace(/\(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+\)/g, '(image)')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{32,}/g, '[image]')
    .replace(/data:[^;,]+;base64,[A-Za-z0-9+/=\s]{200,}/g, '[binary-data]');
}

/** An HTML page as compact markdown text (`readHtml`), its inline images' bytes aside. */
export async function htmlToMarkdown(html: string): Promise<string> {
  return stripBase64Images((await readHtml(html)).markdown);
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
