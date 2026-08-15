/**
 * Model-capability attachment sanitizer — the mechanical fix for the
 * "attached PDF 400s every Workers AI request forever" class of failure.
 *
 * Given the model-visible history and the media kinds the resolved
 * model+provider can actually accept, every file/image part the model cannot
 * take is written ONCE to the workspace VFS (content-addressed under
 * attachments/) and replaced with a text part referencing the path, so
 * the agent can read the payload back with its normal file tools instead of
 * the provider rejecting the whole request.
 *
 * Invariants callers rely on:
 *  - Applied to the WHOLE history every turn assembly: deterministic, heals
 *    already-poisoned transcripts mechanically, and NEVER mutates the
 *    persisted history (copy-on-write per message).
 *  - BYTE-STABLE per part: same payload bytes → same VFS path → same
 *    replacement text, so the prompt-cache prefix invariant holds across
 *    turns. The VFS write is skipped when the file already exists.
 *  - Per-part in-place replacement only — the message COUNT never changes,
 *    so index-anchored consumers (the ephemeral ledger's frozen block
 *    positions, compaction plan ranges) stay valid.
 *  - Small text/* attachments (<8 KB) inline as text instead of a VFS
 *    round-trip; larger ones get the VFS treatment.
 */

import type { AssistantModelMessage, FilePart, ImagePart, ModelMessage, TextPart, UserModelMessage } from 'ai';
import type { VFS } from '../types/primitives.js';
import type { ModelInputModality } from '../providers/types.js';
import { SPILL_DIRS, type TurnContextBudget } from '../context-budget.js';
import { fnv1a64Bytes } from './volatile-context.js';

/** Media kinds an attachment can be — the input-modality vocabulary minus
 *  'text' (text is trivially accepted by every model). */
export type MediaModality = Exclude<ModelInputModality, 'text'>;

export interface AttachmentPolicy {
  /** Media kinds the resolved model+provider transport accepts. Build with
   *  {@link acceptedMediaForModel}. */
  readonly accepts: ReadonlySet<MediaModality>;
  /** The workspace file plane (Storage.vfs) — replaced payloads land here. */
  readonly vfs: VFS;
  /** The turn's bulk ledger. Every offload here is one message-borne spill
   *  trip; the counters answer how often real traffic crosses the threshold. */
  readonly budget?: TurnContextBudget;
}

/** Providers whose native SDK transport can carry PDF document parts.
 *  Everything else rides the OpenAI-compatible chat schema, whose content
 *  parts are `text` | `image_url` ONLY — a `type:"file"` part is a guaranteed
 *  400 (the proven Workers AI failure). */
const PDF_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'codex']);

/**
 * The capability policy: media the resolved model request can carry.
 *
 * Intersection of the provider transport ceiling (what the wire format can
 * express) and the model's catalog-reported input modalities (what the model
 * itself takes — models.dev `modalities.input`). With no catalog entry the
 * ceiling itself is the conservative default: text+image for the
 * OpenAI-compatible family, text+image+pdf for providers whose current model
 * lineups all accept PDFs natively (Anthropic/OpenAI direct).
 */
export function acceptedMediaForModel(opts: {
  provider?: string;
  catalogInputModalities?: readonly ModelInputModality[];
}): ReadonlySet<MediaModality> {
  const ceiling: ReadonlySet<MediaModality> = PDF_CAPABLE_PROVIDERS.has(opts.provider ?? '')
    ? new Set<MediaModality>(['image', 'pdf'])
    : new Set<MediaModality>(['image']);
  if (!opts.catalogInputModalities) return ceiling;
  const accepted = new Set<MediaModality>();
  for (const modality of opts.catalogInputModalities) {
    if (modality !== 'text' && ceiling.has(modality)) accepted.add(modality);
  }
  return accepted;
}

/**
 * The message-borne bulk threshold — ONE number for every text payload that
 * arrives in a message, whether it came as a text/* attachment or as raw
 * pasted prose. Below it the text inlines verbatim: the root must not starve
 * on ordinary material (a stack trace, a config file), which is exactly where
 * reference-only context management loses to plain inlining. Above it the
 * payload spills and the message keeps a bounded head plus the address.
 */
const INLINE_TEXT_MAX_BYTES = 8 * 1024;

/** Head of a spilled paste the message keeps inline — enough for the model to
 *  know what it is holding the address of, never enough to be the payload. */
const PASTED_TEXT_PREVIEW_CHARS = 2_000;

/**
 * Ceiling above which a document the model CAN natively accept is spilled
 * anyway. An inline document part is re-uploaded and re-priced on every
 * single turn for the rest of the session, so a 300-page PDF is a permanent
 * per-turn tax; past this size the workspace copy plus a read-back recipe is
 * the better trade. Documents only — an image has no read-back recipe (the
 * agent cannot see a file it reads as bytes), so accepted images always stay
 * inline regardless of size.
 */
const OVERSIZE_ACCEPTED_DOC_MAX_BYTES = 1024 * 1024;

const ATTACHMENTS_DIR = SPILL_DIRS.attachments;

/**
 * Replace every file/image part the model cannot accept across the whole
 * history. Returns a new array (copy-on-write per message — untouched
 * messages keep referential identity); never mutates the input.
 */
export async function sanitizeAttachmentsForModel(
  messages: readonly ModelMessage[],
  policy: AttachmentPolicy,
): Promise<ModelMessage[]> {
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        out.push(await sanitizeUserMessage(message, message.content, policy));
      } else {
        const replacement = await sanitizeUserText(message.content, policy);
        out.push(replacement === null ? message : { ...message, content: replacement });
      }
    } else if (message.role === 'assistant' && Array.isArray(message.content)) {
      out.push(await sanitizeAssistantMessage(message, message.content, policy));
    } else {
      out.push(message);
    }
  }
  return out;
}

type UserPart = Exclude<UserModelMessage['content'], string>[number];
type AssistantPart = Exclude<AssistantModelMessage['content'], string>[number];

async function sanitizeUserMessage(
  message: UserModelMessage,
  content: readonly UserPart[],
  policy: AttachmentPolicy,
): Promise<UserModelMessage> {
  let changed = false;
  const parts: UserPart[] = [];
  for (const part of content) {
    const replacement =
      part.type === 'image' ? await sanitizeImagePart(part, policy)
      : part.type === 'file' ? await sanitizeFilePart(part, policy)
      : part.type === 'text' ? await sanitizeTextPart(part, policy)
      : null;
    if (replacement) changed = true;
    parts.push(replacement ?? part);
  }
  return changed ? { ...message, content: parts } : message;
}

async function sanitizeAssistantMessage(
  message: AssistantModelMessage,
  content: readonly AssistantPart[],
  policy: AttachmentPolicy,
): Promise<AssistantModelMessage> {
  let changed = false;
  const parts: AssistantPart[] = [];
  for (const part of content) {
    const replacement = part.type === 'file' ? await sanitizeFilePart(part, policy) : null;
    if (replacement) changed = true;
    parts.push(replacement ?? part);
  }
  return changed ? { ...message, content: parts } : message;
}

/** The replacement TextPart for an image part, or null to pass it through. */
async function sanitizeImagePart(part: ImagePart, policy: AttachmentPolicy): Promise<TextPart | null> {
  if (policy.accepts.has('image')) return null;
  return replaceMedia(part.image, part.mediaType ?? 'image', undefined, policy);
}

/** The replacement TextPart for a file part, or null to pass it through. */
async function sanitizeFilePart(part: FilePart, policy: AttachmentPolicy): Promise<TextPart | null> {
  const modality = mediaModalityFor(part.mediaType);
  if (modality !== null && policy.accepts.has(modality)) {
    return modality !== 'image' && oversizeForInlineDocument(part.data)
      ? replaceMedia(part.data, part.mediaType, part.filename, policy)
      : null;
  }
  if (isTextMediaType(part.mediaType)) return inlineOrStoreText(part, policy);
  return replaceMedia(part.data, part.mediaType, part.filename, policy);
}

/** A text part carrying more than the message-borne budget — the giant paste.
 *  Returns the replacement part, or null to pass it through. */
async function sanitizeTextPart(part: TextPart, policy: AttachmentPolicy): Promise<TextPart | null> {
  const replacement = await sanitizeUserText(part.text, policy);
  return replacement === null ? null : { ...part, text: replacement };
}

/**
 * The replacement for one oversize user text payload: the full text lands
 * content-addressed on the file plane and the message keeps a bounded head
 * plus the path. Byte-stable — same bytes, same path, same replacement — so a
 * pasted document does not move the prompt-cache prefix every turn. Returns
 * null when the text is within budget (the overwhelming majority).
 */
async function sanitizeUserText(text: string, policy: AttachmentPolicy): Promise<string | null> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= INLINE_TEXT_MAX_BYTES) return null;
  const path = await storeContentAddressed(bytes, 'text/plain', policy);
  const head = text.slice(0, PASTED_TEXT_PREVIEW_CHARS);
  policy.budget?.recordSpill({
    producer: 'pasted_text', omitted: text.length - head.length, referenced: true,
  });
  return `[Pasted text (${bytes.length} bytes) saved to ${path} — read or slice it with your file tools ` +
    `(oversize: slice + llm.query each slice, aggregate). The first ${head.length} chars follow.]\n\n${head}`;
}

/** True when a natively-acceptable document is large enough that carrying it
 *  inline costs more than the read-back hop. Sized without decoding: base64
 *  payloads are ~4/3 of their bytes, and a remote URL has no local payload. */
function oversizeForInlineDocument(data: FilePart['data']): boolean {
  const bytes = estimatePayloadBytes(data);
  return bytes !== null && bytes > OVERSIZE_ACCEPTED_DOC_MAX_BYTES;
}

function estimatePayloadBytes(data: FilePart['data'] | ImagePart['image']): number | null {
  if (data instanceof URL) return null;
  if (data instanceof Uint8Array) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (/^https?:\/\//.test(data)) return null;
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  return Math.floor(((comma === -1 ? data.length : data.length - comma - 1) * 3) / 4);
}

/** The media kind of a file part, or null when no model transport accepts it
 *  (unknown/binary media always gets the VFS treatment). Text is handled
 *  separately — see {@link inlineOrStoreText}. */
function mediaModalityFor(mediaType: string): MediaModality | null {
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('video/')) return 'video';
  return null;
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/');
}

/** text/* attachments: small ones inline verbatim (no VFS round-trip needed
 *  to read them), larger ones get the standard VFS treatment. */
async function inlineOrStoreText(file: FilePart, policy: AttachmentPolicy): Promise<TextPart> {
  const payload = decodePayload(file.data);
  if (payload.kind === 'remote') return remoteReference(file.data, file.mediaType, file.filename);
  if (payload.bytes.length < INLINE_TEXT_MAX_BYTES) {
    const name = file.filename ?? 'attachment.txt';
    const text = new TextDecoder().decode(payload.bytes);
    return {
      type: 'text',
      text: `[Attachment ${name} (${file.mediaType}, ${payload.bytes.length} bytes) inlined below]\n\n${text}`,
    };
  }
  return storeAndReference(payload.bytes, file.mediaType, file.filename, policy);
}

async function replaceMedia(
  data: FilePart['data'] | ImagePart['image'],
  mediaType: string,
  filename: string | undefined,
  policy: AttachmentPolicy,
): Promise<TextPart> {
  const payload = decodePayload(data);
  if (payload.kind === 'remote') return remoteReference(data, mediaType, filename);
  return storeAndReference(payload.bytes, mediaType, filename, policy);
}

/** Content-addressed VFS write (skipped when the path already exists) + the
 *  byte-stable replacement text. */
async function storeAndReference(
  bytes: Uint8Array,
  mediaType: string,
  filename: string | undefined,
  policy: AttachmentPolicy,
): Promise<TextPart> {
  const path = await storeContentAddressed(bytes, mediaType, policy);
  const basename = path.slice(ATTACHMENTS_DIR.length + 1);
  policy.budget?.recordSpill({ producer: 'attachment', omitted: bytes.length, referenced: true });
  const name = filename ?? basename;
  return {
    type: 'text',
    text: `[Attachment ${name} (${mediaType}, ${bytes.length} bytes) saved to ${path} — read it with your file tools]`,
  };
}

/** Content-addressed VFS write (skipped when the path already exists), the one
 *  offload every message-borne producer here shares. */
async function storeContentAddressed(
  bytes: Uint8Array,
  mediaType: string,
  policy: AttachmentPolicy,
): Promise<string> {
  const path = `${ATTACHMENTS_DIR}/${fnv1a64Bytes(bytes)}.${extensionFor(mediaType)}`;
  if (!(await policy.vfs.exists(path))) {
    try {
      await policy.vfs.mkdir(ATTACHMENTS_DIR, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      if (!msg.includes('exist')) throw err;
    }
    await policy.vfs.writeFile(path, bytes);
  }
  return path;
}

/** A part whose data is a remote URL carries no payload to store — reference
 *  the URL itself (equally byte-stable). */
function remoteReference(
  data: FilePart['data'] | ImagePart['image'],
  mediaType: string,
  filename: string | undefined,
): TextPart {
  const url = data instanceof URL ? data.toString() : String(data);
  const name = filename ?? url;
  return {
    type: 'text',
    text: `[Attachment ${name} (${mediaType}) at ${url} — fetch it with your web tools]`,
  };
}

type DecodedPayload =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'remote' };

/** Decode every DataContent carrier to raw bytes: data URLs (base64 or
 *  percent-encoded), bare base64 strings (the DataContent contract), and
 *  binary views. Remote http(s) URLs have no local payload. */
function decodePayload(data: FilePart['data'] | ImagePart['image']): DecodedPayload {
  if (data instanceof URL) return { kind: 'remote' };
  if (data instanceof Uint8Array) return { kind: 'bytes', bytes: data };
  if (data instanceof ArrayBuffer) return { kind: 'bytes', bytes: new Uint8Array(data) };
  if (data.startsWith('data:')) return { kind: 'bytes', bytes: decodeDataUrl(data) };
  if (/^https?:\/\//.test(data)) return { kind: 'remote' };
  return { kind: 'bytes', bytes: decodeBase64OrText(data) };
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const header = comma === -1 ? dataUrl : dataUrl.slice(0, comma);
  const payload = comma === -1 ? '' : dataUrl.slice(comma + 1);
  if (header.includes(';base64')) return decodeBase64OrText(payload);
  return new TextEncoder().encode(decodeURIComponent(payload));
}

/** DataContent strings are base64 by contract; a string that isn't valid
 *  base64 is treated as UTF-8 text so a malformed part can never break the
 *  turn (the sanitizer's whole job is preventing request-killing payloads). */
function decodeBase64OrText(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return new TextEncoder().encode(value);
  }
}

interface AttachmentExtensions {
  [mediaType: string]: string;
}

/** Deterministic file extension for the content-addressed path. */
function extensionFor(mediaType: string): string {
  const known: AttachmentExtensions = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'audio/mpeg': 'mp3',
  };
  const mapped = known[mediaType];
  if (mapped) return mapped;
  const subtype = mediaType.slice(mediaType.indexOf('/') + 1).replace(/[^A-Za-z0-9]/g, '');
  return subtype || 'bin';
}
