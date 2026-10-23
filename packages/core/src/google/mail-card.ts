// What a Google write's card shows of a message it sends or keeps: its recipients, subject and how its text begins,
// read from the RFC 2822 message Gmail takes base64url-encoded in `raw`.
import { base64ToBytes } from '../utils/base64';
import { tolerate } from '../obs/index';
import type { GoogleWrite } from '../safety/approval-kind';

/** How much of a message's text the card shows. */
const START_CHARS = 400;

function fromBase64Url(text: string): string {
  const standard = text.replaceAll('-', '+').replaceAll('_', '/');
  const bytes = tolerate(() => base64ToBytes(standard.padEnd(Math.ceil(standard.length / 4) * 4, '=')), 'malformed-input');

  return bytes === undefined ? '' : new TextDecoder().decode(bytes);
}

/** A MIME part: its headers by lower-case name, folded lines unfolded, and its body. */
interface Part {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

function split(part: string): Part {
  const normal = part.replaceAll('\r\n', '\n');
  const end = normal.indexOf('\n\n');
  const head = end === -1 ? normal : normal.slice(0, end);
  const headers = new Map<string, string>();

  for (const line of head.replace(/\n[ \t]+/gu, ' ').split('\n')) {
    const colon = line.indexOf(':');

    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }

  return { headers, body: end === -1 ? '' : normal.slice(end + 2) };
}

/** A part's text as it reads: base64 decoded, quoted-printable's soft breaks and escapes undone. */
function readable(part: Part): string {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '').toLowerCase();

  if (encoding === 'base64') return new TextDecoder().decode(tolerate(() => base64ToBytes(part.body.replace(/\s+/gu, '')), 'malformed-input') ?? new Uint8Array());

  if (encoding === 'quoted-printable') return part.body.replace(/=\n/gu, '').replace(/=([0-9A-F]{2})/giu, (_all, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));

  return part.body;
}

/** The text a reader sees first: the message's own, or its first `text/plain` part, nested parts searched in order. */
function textOf(part: Part, depth = 0): string {
  const type = part.headers.get('content-type') ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/iu.exec(type)?.[1];

  if (!type.toLowerCase().startsWith('multipart/') || boundary === undefined || depth > 3) return readable(part);

  for (const inner of part.body.split(`--${boundary}`).slice(1)) {
    const parsed = split(inner.replace(/^\n/u, ''));
    const innerType = (parsed.headers.get('content-type') ?? 'text/plain').toLowerCase();

    if (innerType.startsWith('text/plain') || innerType.startsWith('multipart/')) {
      const text = textOf(parsed, depth + 1).trim();

      if (text !== '') return text;
    }
  }

  return '';
}

/** A message as a card draws it, from Gmail's `raw`; null for one that holds none. */
export function mailCardOf(raw: string | undefined): GoogleWrite['mail'] {
  if (raw === undefined || raw === '') return null;
  const message = split(fromBase64Url(raw));

  return {
    to: message.headers.get('to') ?? '',
    cc: message.headers.get('cc') ?? '',
    subject: message.headers.get('subject') ?? '',
    start: textOf(message).replace(/\s+/gu, ' ').trim().slice(0, START_CHARS),
  };
}
