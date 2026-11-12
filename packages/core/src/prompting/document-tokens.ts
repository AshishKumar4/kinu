/**
 * What a document shown inline costs a model, by the one rule Kinu holds for documents (`media-tokens.ts` prices images
 * by each provider's own rule): a PDF by its pages, each priced as Claude prices one (OpenAI's file inputs send each
 * page's text and its image too, and publish no rule); anything else, and a PDF whose pages cannot be counted, by its
 * bytes as text.
 */
import { estimateTokens } from '../token-estimate';

/** Claude's own estimate of one PDF page, its text and its image (Anthropic's PDF support page, 1,500 to 3,000). */
export const PDF_PAGE_TOKENS = 1500;

/** A PDF's pages, by its page objects; null where it names none. UTF-8 decoding keeps every ASCII byte as itself,
 *  which is all the page markers are. */
export function pdfPageCount(bytes: Uint8Array): number | null {
  const count = new TextDecoder().decode(bytes).match(/\/Type\s*\/Page(?![a-z])/gu)?.length ?? 0;

  return count === 0 ? null : count;
}

export function documentTokens(mediaType: string, bytes: Uint8Array): number {
  const pages = mediaType === 'application/pdf' ? pdfPageCount(bytes) : null;

  return pages === null ? estimateTokens(bytes.byteLength) : pages * PDF_PAGE_TOKENS;
}
