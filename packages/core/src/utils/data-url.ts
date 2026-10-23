/** A `data:` URL as RFC 2397 reads it, one reader for every place an image or file arrives as one. */

/** What a data URL carries: its media type, and its bytes as base64 when it says `;base64`. */
export interface DataUrl {
  readonly mediaType: string;
  /** The payload, whitespace a wrapped base64 holds removed; percent-encoded text as written otherwise. */
  readonly data: string;
  readonly base64: boolean;
}

/**
 * `text` read as a data URL: `data:[<mediatype>][;param=value]*[;base64],<data>`, its parameters (`;name=a.png`,
 * `;charset=…`) allowed, the scheme in any case, and a base64 payload wrapped across lines unwrapped. A media type left
 * out is `text/plain`, as the RFC says. Null for anything else.
 */
export function readDataUrl(text: string): DataUrl | null {
  if (!/^data:/iu.test(text)) return null;
  const comma = text.indexOf(',');

  if (comma === -1) return null;
  const [type = '', ...parameters] = text.slice('data:'.length, comma).split(';');
  const base64 = parameters.at(-1)?.trim().toLowerCase() === 'base64';
  const payload = text.slice(comma + 1);

  return { mediaType: type.trim().toLowerCase() || 'text/plain', data: base64 ? payload.replace(/\s+/gu, '') : payload, base64 };
}

/** The image formats a model and a browser both read. */
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** `text` as an inline image: a base64 data URL of PNG, JPEG, WebP or GIF whose payload is base64; null otherwise. */
export function imageDataUrl(text: string): { readonly mediaType: string; readonly data: string } | null {
  const url = readDataUrl(text);

  return url !== null && url.base64 && IMAGE_TYPES.has(url.mediaType) && /^[A-Za-z0-9+/]+=*$/u.test(url.data)
    ? { mediaType: url.mediaType, data: url.data }
    : null;
}
