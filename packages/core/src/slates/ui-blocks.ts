import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settleSync } from '../obs/effect';

/**
 * `<slate-ui name="…">…</slate-ui>` blocks in an agent's answer: each is an ephemeral slate, an HTML page whose
 * source is the stored message, addressed as `<message id>/<name>`. A tag counts only where it opens a line outside a
 * code fence, so prose and examples that mention the tag stay prose.
 */

/** The attribute a rendered block's card carries, holding the block's name. */
export const SLATE_UI_ATTRIBUTE = 'data-slate-ui';

const CLOSE = '</slate-ui>';

const OPEN = /^[ \t]*<slate-ui\b([^>]*)>/;

const NAME_ATTRIBUTE = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const FENCE = /^[ \t]*(`{3,}|~{3,})/;

export interface SlateUiBlock {
  readonly name: string;
  readonly html: string;
}

export type SlateUiSegment =
  | { readonly kind: 'text'; readonly text: string }
  | ({ readonly kind: 'slate' } & SlateUiBlock)
  /** An opening tag whose close has not arrived: still streaming, or never closed, when `text` is all it is. */
  | { readonly kind: 'open'; readonly name: string; readonly text: string };

function blockName(attributes: string): string | null {
  const found = NAME_ATTRIBUTE.exec(attributes);
  const name = found?.[1] ?? found?.[2];

  return name !== undefined && NAME.test(name) ? name : null;
}

/** Whether the line toggles a fence: an open one closes on a marker of its own kind at least as long. */
function fenceAfter(fence: string | null, line: string): string | null {
  const marker = FENCE.exec(line)?.[1];

  if (marker === undefined) return fence;

  if (fence === null) return marker;

  return marker[0] === fence[0] && marker.length >= fence.length ? null : fence;
}

/** The answer in order: prose, blocks, and at most one trailing open block. */
export function slateUiSegments(text: string): SlateUiSegment[] {
  const segments: SlateUiSegment[] = [];
  let prose = 0;
  let line = 0;
  let fence: string | null = null;

  while (line < text.length) {
    const lineEnd = text.indexOf('\n', line) === -1 ? text.length : text.indexOf('\n', line);
    const open = fence === null ? OPEN.exec(text.slice(line, lineEnd)) : null;
    const name = open === null ? null : blockName(open[1] ?? '');

    if (open === null || name === null) {
      fence = fenceAfter(fence, text.slice(line, lineEnd));
      line = lineEnd + 1;
      continue;
    }

    if (prose < line) segments.push({ kind: 'text', text: text.slice(prose, line) });
    const body = line + open[0].length;
    const close = text.indexOf(CLOSE, body);

    if (close === -1) return [...segments, { kind: 'open', name, text: text.slice(line) }];
    segments.push({ kind: 'slate', name, html: text.slice(body, close).trim() });
    prose = close + CLOSE.length;
    line = text.indexOf('\n', prose) === -1 ? text.length : text.indexOf('\n', prose) + 1;
  }

  return prose < text.length ? [...segments, { kind: 'text', text: text.slice(prose) }] : segments;
}

/** The block of an answer's text that an address names, the first of that name; refused when the answer holds none. */
export function addressedBlock(text: string, address: EphemeralSlateAddress): SlateUiBlock {
  const block = slateUiSegments(text).find((segment) => segment.kind === 'slate' && segment.name === address.name);

  if (block?.kind !== 'slate') return settleSync(Effect.fail(new KinuError('missing', `Answer ${address.messageId} holds no slate-ui block named ${address.name}`)));

  return { name: block.name, html: block.html };
}

export interface EphemeralSlateAddress {
  readonly messageId: string;
  readonly name: string;
}

/** A file slate's id is one directory name, so the one `/` here cannot be mistaken for one. */
export function ephemeralSlateId(address: EphemeralSlateAddress): string {
  return `${address.messageId}/${address.name}`;
}

export function ephemeralSlateAddress(id: string): EphemeralSlateAddress | null {
  const cut = id.indexOf('/');

  if (cut <= 0 || cut !== id.lastIndexOf('/')) return null;
  const name = id.slice(cut + 1);

  return NAME.test(name) && !id.includes('\0') ? { messageId: id.slice(0, cut), name } : null;
}
