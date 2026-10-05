/** Message file payloads as ai 7 shapes them. */
import type { DataContent, FilePart, ImagePart } from 'ai';
import * as v from 'valibot';

/**
 * A part's payload bare, as ai 6 took it: bytes, base64 or a data URL, or a URL. ai 7 also tags each (`{ type: 'data' }`
 * and the rest) and adds inline text and provider references; a reference, which names no local bytes, is null.
 */
export function untagged(data: FilePart['data'] | ImagePart['image']): DataContent | URL | null {
  if (v.is(v.string(), data) || data instanceof URL || data instanceof Uint8Array || data instanceof ArrayBuffer) return data;

  switch (data.type) {
    case 'data': return data.data;
    case 'url': return data.url;
    case 'text': return new TextEncoder().encode(data.text);
    case 'reference':
    case undefined: return null;
  }
}
