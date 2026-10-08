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

/** Any line that may open a fence opens one: reading too much as code only keeps a block from being drawn. */
const FENCE_OPEN = /^[ \t]*(`{3,}(?=[^`]*$)|~{3,})/;

/** Only a Markdown closing fence closes one: a marker alone on its line, indented at most three spaces. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

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

/** The fence open after this line: an open one closes on a closing fence of its own kind at least as long. */
function fenceAfter(fence: string | null, line: string): string | null {
  if (fence === null) return FENCE_OPEN.exec(line)?.[1] ?? null;
  const marker = FENCE_CLOSE.exec(line)?.[1];

  return marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length ? null : fence;
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

/** The block of an answer's texts that an address names, the first of that name; refused when the answer holds none. */
export function addressedBlock(texts: readonly string[], address: EphemeralSlateAddress): SlateUiBlock {
  const block = texts.flatMap(slateUiSegments).find((segment) => segment.kind === 'slate' && segment.name === address.name);

  if (block?.kind !== 'slate') return settleSync(Effect.fail(new KinuError('missing', `Answer ${address.messageId} holds no slate-ui block named ${address.name}`)));

  return { name: block.name, html: block.html };
}

export interface EphemeralSlateAddress {
  /** The agent whose own chat holds the answer; null for the workspace's. */
  readonly actorId: string | null;
  readonly messageId: string;
  readonly name: string;
}

/** A file slate's id is one directory name, so the `/` here cannot be mistaken for one: `<message>/<name>` in the
 *  workspace's chat, `<agent>/<message>/<name>` in an agent's. */
export function ephemeralSlateId(address: EphemeralSlateAddress): string {
  return [address.actorId, address.messageId, address.name].filter((part) => part !== null).join('/');
}

export function ephemeralSlateAddress(id: string): EphemeralSlateAddress | null {
  const parts = id.split('/');
  const name = parts.at(-1) ?? '';

  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === '') || !NAME.test(name) || id.includes('\0')) return null;

  return parts.length === 3
    ? { actorId: parts[0] ?? '', messageId: parts[1] ?? '', name }
    : { actorId: null, messageId: parts[0] ?? '', name };
}
