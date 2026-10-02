import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Replaces parts the resolved model cannot accept with content-addressed VFS copies plus a text reference.
 * Applied to the whole history each turn, never mutating it; byte-stable (prompt-cache prefix); message count
 * never changes, so index-anchored consumers stay valid.
 */

import type { AssistantModelMessage, FilePart, ImagePart, ModelMessage, TextPart, UserModelMessage } from 'ai';
import { Cause, Effect } from 'effect';

import type { ModelInputModality } from '../providers/types';
import { SPILL_DIRS, type TurnContextBudget } from '../context-budget';
import { classify, diagnostics, renderThrownChain, toKinuError, type KinuError } from '../obs/index';
import { settle } from '../obs/effect';
import { sha256Hex } from '../safety/argument-digest';
import { base64ToBytes } from '../utils/base64';

/** Every model accepts text. */
export type MediaModality = Exclude<ModelInputModality, 'text'>;

export interface AttachmentPolicy {
  readonly accepts: ReadonlySet<MediaModality>;
  readonly vfs: VFS;
  /** Counters show how often real traffic crosses the spill threshold. */
  readonly budget?: TurnContextBudget;
}

/** Other providers use the OpenAI-compatible schema, where a `type:"file"` part is a guaranteed 400. */
const PDF_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'claude', 'openai', 'codex', 'chatgpt']);

/** Transport ceiling ∩ catalog input modalities; the ceiling alone when the catalog has no entry. */
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

/** One threshold for all message-borne text: inline below, spill with a bounded head above. */
const INLINE_TEXT_MAX_BYTES = 8 * 1024;

/** Enough to identify the payload, never enough to be it. */
const PASTED_TEXT_PREVIEW_CHARS = 2_000;

/** Inline documents are re-priced every turn, so large ones spill anyway. Images always stay inline: no read-back recipe exists. */
const OVERSIZE_ACCEPTED_DOC_MAX_BYTES = 1024 * 1024;

const ATTACHMENTS_DIR = SPILL_DIRS.attachments;

/** Copy-on-write per message; untouched messages keep referential identity. */
export function sanitizeAttachmentsForModel(
  messages: readonly ModelMessage[],
  policy: AttachmentPolicy,
): Promise<ModelMessage[]> {
  return settle(Effect.gen(function* () {
    const out: ModelMessage[] = [];

    for (const message of messages) {
      if (message.role === 'user') {
        if (Array.isArray(message.content)) {
          out.push(yield* sanitizeUserMessage(message, message.content, policy));
        } else {
          const replacement = yield* sanitizeUserText(message.content, policy);
          out.push(replacement === null ? message : { ...message, content: replacement });
        }
      } else if (message.role === 'assistant' && Array.isArray(message.content)) {
        out.push(yield* sanitizeAssistantMessage(message, message.content, policy));
      } else {
        out.push(message);
      }
    }

    return out;
  }));
}

type Sanitized<A> = Effect.Effect<A, KinuError>;

type UserPart = Exclude<UserModelMessage['content'], string>[number];

type AssistantPart = Exclude<AssistantModelMessage['content'], string>[number];

function sanitizeUserMessage(
  message: UserModelMessage,
  content: readonly UserPart[],
  policy: AttachmentPolicy,
): Sanitized<UserModelMessage> {
  return Effect.gen(function* () {
    let changed = false;
    const parts: UserPart[] = [];

    for (const part of content) {
      const replacement = yield* sanitizePart(part, policy);

      if (replacement) changed = true;
      parts.push(replacement ?? part);
    }

    return changed ? { ...message, content: parts } : message;
  });
}

function sanitizeAssistantMessage(
  message: AssistantModelMessage,
  content: readonly AssistantPart[],
  policy: AttachmentPolicy,
): Sanitized<AssistantModelMessage> {
  return Effect.gen(function* () {
    let changed = false;
    const parts: AssistantPart[] = [];

    for (const part of content) {
      const replacement = part.type === 'file' ? yield* sanitizeFilePart(part, policy) : null;

      if (replacement) changed = true;
      parts.push(replacement ?? part);
    }

    return changed ? { ...message, content: parts } : message;
  });
}

/** Only the three carrier kinds can hold an attachment. */
function sanitizePart(part: UserPart, policy: AttachmentPolicy): Sanitized<TextPart | null> {
  if (part.type === 'image') return sanitizeImagePart(part, policy);

  if (part.type === 'file') return sanitizeFilePart(part, policy);

  if (part.type === 'text') return sanitizeTextPart(part, policy);

  return Effect.succeed(null);
}

function sanitizeImagePart(part: ImagePart, policy: AttachmentPolicy): Sanitized<TextPart | null> {
  if (part.mediaType !== undefined && !RASTER_IMAGES.has(part.mediaType)) {
    return sanitizeFilePart({ type: 'file', data: part.image, mediaType: part.mediaType }, policy);
  }

  if (policy.accepts.has('image')) return Effect.succeed(null);

  return replaceMedia(part.image, part.mediaType ?? 'image', undefined, policy);
}

function sanitizeFilePart(part: FilePart, policy: AttachmentPolicy): Sanitized<TextPart | null> {
  const modality = mediaModalityFor(part.mediaType);

  if (modality !== null && policy.accepts.has(modality)) {
    return modality !== 'image' && oversizeForInlineDocument(part.data)
      ? replaceMedia(part.data, part.mediaType, part.filename, policy)
      : Effect.succeed(null);
  }

  if (isTextMediaType(part.mediaType)) return inlineOrStoreText(part, policy);

  return replaceMedia(part.data, part.mediaType, part.filename, policy);
}

function sanitizeTextPart(part: TextPart, policy: AttachmentPolicy): Sanitized<TextPart | null> {
  return Effect.map(sanitizeUserText(part.text, policy), (replacement) => (replacement === null ? null : { ...part, text: replacement }));
}

/** Byte-stable, so a pasted document does not move the prompt-cache prefix. Null within budget. */
function sanitizeUserText(text: string, policy: AttachmentPolicy): Sanitized<string | null> {
  const bytes = new TextEncoder().encode(text);

  if (bytes.length <= INLINE_TEXT_MAX_BYTES) return Effect.succeed(null);

  return Effect.map(storeContentAddressed(bytes, 'text/plain', policy), (path) => {
  const head = text.slice(0, PASTED_TEXT_PREVIEW_CHARS);
  policy.budget?.recordSpill({
    producer: 'pasted_text', omitted: text.length - head.length, referenced: true,
  });

  return `[Pasted text (${bytes.length} bytes) saved to ${path} (read or slice it with your file tools; ` +
    `oversize: name ${path} in the mission of a lifetime:"task" agents hire so that agent reads it instead of you). The first ${head.length} chars follow.]\n\n${head}`;
  });
}

/** Sized without decoding: base64 is ~4/3 of the bytes; remote URLs have no local payload. */
function oversizeForInlineDocument(data: FilePart['data']): boolean {
  const bytes = estimatePayloadBytes(data);

  return bytes !== null && bytes > OVERSIZE_ACCEPTED_DOC_MAX_BYTES;
}

function estimatePayloadBytes(data: FilePart['data']): number | null {
  if (data instanceof URL) return null;

  if (data instanceof Uint8Array) return data.byteLength;

  if (data instanceof ArrayBuffer) return data.byteLength;

  if (/^https?:\/\//.test(data)) return null;
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;

  return Math.floor(((comma === -1 ? data.length : data.length - comma - 1) * 3) / 4);
}

/** An SVG is markup: it goes as text. */
const RASTER_IMAGES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Null means no transport accepts it; text is handled by {@link inlineOrStoreText}. */
function mediaModalityFor(mediaType: string): MediaModality | null {
  if (RASTER_IMAGES.has(mediaType)) return 'image';

  if (mediaType === 'application/pdf') return 'pdf';

  if (mediaType.startsWith('audio/')) return 'audio';

  if (mediaType.startsWith('video/')) return 'video';

  return null;
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith('text/') || mediaType === 'image/svg+xml';
}

function inlineOrStoreText(file: FilePart, policy: AttachmentPolicy): Sanitized<TextPart> {
  return Effect.gen(function* () {
    const payload = yield* decodePayload(file.data);

    if (payload.kind === 'remote') return remoteReference(payload.url, file.mediaType, file.filename);

    if (payload.bytes.length < INLINE_TEXT_MAX_BYTES) {
      const name = file.filename ?? 'attachment.txt';
      const text = new TextDecoder().decode(payload.bytes);

      return {
        type: 'text',
        text: `[Attachment ${name} (${file.mediaType}, ${payload.bytes.length} bytes) inlined below]\n\n${text}`,
      } satisfies TextPart;
    }

    return yield* storeAndReference(payload.bytes, file.mediaType, file.filename, policy);
  });
}

function replaceMedia(
  data: FilePart['data'],
  mediaType: string,
  filename: string | undefined,
  policy: AttachmentPolicy,
): Sanitized<TextPart> {
  return Effect.flatMap(decodePayload(data), (payload) => (payload.kind === 'remote'
    ? Effect.succeed(remoteReference(payload.url, mediaType, filename))
    : storeAndReference(payload.bytes, mediaType, filename, policy)));
}

function storeAndReference(
  bytes: Uint8Array,
  mediaType: string,
  filename: string | undefined,
  policy: AttachmentPolicy,
): Sanitized<TextPart> {
  return Effect.map(storeContentAddressed(bytes, mediaType, policy), (path) => {
  const basename = path.slice(ATTACHMENTS_DIR.length + 1);
  policy.budget?.recordSpill({ producer: 'attachment', omitted: bytes.length, referenced: true });
  const name = filename ?? basename;

  return {
    type: 'text',
    text: `[Attachment ${name} (${mediaType}, ${bytes.length} bytes) saved to ${path} (read it with your file tools)]`,
  };
  });
}

/** Reuse verifies the bytes: an existing path (truncated write, agent-written file) is not proof of content. */
function storeContentAddressed(
  bytes: Uint8Array,
  mediaType: string,
  policy: AttachmentPolicy,
): Sanitized<string> {
  return Effect.gen(function* () {
    const path = `${ATTACHMENTS_DIR}/${sha256Hex(bytes)}.${extensionFor(mediaType)}`;

    if (yield* holdsBytes(policy.vfs, path, bytes)) return path;

    yield* Effect.catchCause(Effect.promise(async () => policy.vfs.mkdir(ATTACHMENTS_DIR, { recursive: true })), (failed) => {
      const err = Cause.squash(failed);

      return classify({ cause: err }) === 'eexist'
        ? Effect.void
        : Effect.fail(toKinuError({ doing: 'creating the attachments spill directory', cause: err, otherwise: 'io' }));
    });
    yield* Effect.promise(async () => policy.vfs.writeFile(path, bytes));

    return path;
  });
}

/** Absent is the ordinary first spill; mismatched bytes are rewritten. */
function holdsBytes(vfs: VFS, path: string, bytes: Uint8Array): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    if (!(yield* Effect.promise(() => exists(vfs, path)))) return false;
    const stored = yield* Effect.promise(async () => vfs.readFile(path));
    // Narrowed by class, as prompting/agents-md.ts does for the same VFS return.
    const existing = stored instanceof Uint8Array ? stored : new TextEncoder().encode(stored);

    if (existing.length !== bytes.length) return false;

    for (let i = 0; i < bytes.length; i++) {
      if (existing[i] !== bytes[i]) return false;
    }

    return true;
  });
}

/** Remote URLs are referenced directly (equally byte-stable). */
function remoteReference(url: string, mediaType: string, filename: string | undefined): TextPart {
  const name = filename ?? url;

  return {
    type: 'text',
    text: `[Attachment ${name} (${mediaType}) at ${url} (fetch it with your web tools)]`,
  };
}

type DecodedPayload =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'remote'; url: string };

function decodePayload(data: FilePart['data']): Effect.Effect<DecodedPayload> {
  if (data instanceof URL) return Effect.succeed({ kind: 'remote', url: data.toString() });

  if (data instanceof Uint8Array) return Effect.succeed({ kind: 'bytes', bytes: data });

  if (data instanceof ArrayBuffer) return Effect.succeed({ kind: 'bytes', bytes: new Uint8Array(data) });

  if (/^https?:\/\//.test(data)) return Effect.succeed({ kind: 'remote', url: data });
  const bytes = data.startsWith('data:') ? decodeDataUrl(data) : decodeBase64OrText(data);

  return Effect.map(bytes, (decoded): DecodedPayload => ({ kind: 'bytes', bytes: decoded }));
}

function decodeDataUrl(dataUrl: string): Effect.Effect<Uint8Array> {
  const comma = dataUrl.indexOf(',');
  const header = comma === -1 ? dataUrl : dataUrl.slice(0, comma);
  const payload = comma === -1 ? '' : dataUrl.slice(comma + 1);

  if (header.includes(';base64')) return decodeBase64OrText(payload);

  return Effect.sync(() => new TextEncoder().encode(decodeURIComponent(payload)));
}

/** Invalid base64 is treated as UTF-8 so a malformed part cannot break the turn. */
function decodeBase64OrText(value: string): Effect.Effect<Uint8Array> {
  return Effect.catchCause(Effect.sync(() => base64ToBytes(value)), (failed) => Effect.sync(() => {
    diagnostics.event('attachment.base64_decode_fallback', { error: renderThrownChain({ cause: Cause.squash(failed) }) });

    return new TextEncoder().encode(value);
  }));
}

interface AttachmentExtensions {
  [mediaType: string]: string;
}

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
