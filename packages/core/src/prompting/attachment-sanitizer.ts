import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * Replaces parts the resolved model cannot accept with a text reference to their bytes: the owner's upload where the
 * file part says it was saved ({@link saveUploads}), else a content-addressed copy in the hidden offloaded directory.
 * Applied to the whole history each turn, never mutating it; byte-stable (prompt-cache prefix); message count
 * never changes, so index-anchored consumers stay valid.
 */

import type { AssistantModelMessage, DataContent, FilePart, ImagePart, ModelMessage, TextPart, UserModelMessage } from 'ai';
import { untagged } from '../utils/file-data';

import type { ModelInputModality } from '../providers/types';
import { SPILL_DIRS, type TurnContextBudget } from '../context-budget';
import { classify, diagnostics, KinuError, renderThrownChain, settle, toKinuError } from '../obs/index';
import { Effect } from 'effect';
import { UPLOADS_ROOT } from '../vfs/workspace-path';
import { resolvePath, vfsReference, type PathPlanes } from '../vfs/resolve';
import * as v from 'valibot';
import { sha256Hex } from '../safety/argument-digest';

/** Every model accepts text. */
export type MediaModality = Exclude<ModelInputModality, 'text'>;

export interface AttachmentPolicy {
  readonly accepts: ReadonlySet<MediaModality>;
  readonly vfs: VFS;
  /** Where the workspace's own paths sit on this machine, by which an upload is named; absent, they are its own. */
  readonly planes?: PathPlanes;
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

const OFFLOADED_DIR = SPILL_DIRS.offloaded;

/** Copy-on-write per message, and of the list from its first changed message: untouched messages keep referential
 *  identity, and an untouched history is returned as given. Every step sanitizes the whole history. */
export async function sanitizeAttachmentsForModel(
  messages: readonly ModelMessage[],
  policy: AttachmentPolicy,
): Promise<readonly ModelMessage[]> {
  let out: ModelMessage[] | undefined;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const sanitized = mayCarryAttachments(message) ? await sanitizeMessage(message, policy) : message;

    if (sanitized !== message) out ??= messages.slice(0, index);
    out?.push(sanitized);
  }

  return out ?? messages;
}

/** Only a file part can carry an attachment: the rest of a long turn's answers pass without a copy or an await. */
function mayCarryAttachments(message: ModelMessage): boolean {
  return message.role === 'user' || (message.role === 'assistant' && Array.isArray(message.content) && message.content.some((part) => part.type === 'file'));
}

async function sanitizeMessage(message: ModelMessage, policy: AttachmentPolicy): Promise<ModelMessage> {
  if (message.role === 'assistant' && Array.isArray(message.content)) return sanitizeAssistantMessage(message, message.content, policy);

  if (message.role !== 'user') return message;

  if (Array.isArray(message.content)) return sanitizeUserMessage(message, message.content, policy);
  const replacement = await sanitizeUserText(message.content, policy);

  return replacement === null ? message : { ...message, content: replacement };
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
    const replacement = await sanitizePart(part, policy);
    const upload = part.type === 'file' ? uploadOf(part) : null;

    // An upload the model takes as it is still names where it was saved, so the agent can work on the file.
    if (replacement === null && upload !== null && part.type === 'file') parts.push(uploadNote(part, onThisMachine(upload, policy.planes)));

    if (replacement || upload !== null) changed = true;
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

/** Only the three carrier kinds can hold an attachment. */
async function sanitizePart(part: UserPart, policy: AttachmentPolicy): Promise<TextPart | null> {
  if (part.type === 'image') return await sanitizeImagePart(part, policy);

  if (part.type === 'file') return await sanitizeFilePart(part, policy);

  if (part.type === 'text') return await sanitizeTextPart(part, policy);

  return null;
}

async function sanitizeImagePart(part: ImagePart, policy: AttachmentPolicy): Promise<TextPart | null> {
  if (part.mediaType !== undefined && !RASTER_IMAGES.has(part.mediaType)) {
    return sanitizeFilePart({ type: 'file', data: part.image, mediaType: part.mediaType }, policy);
  }

  const data = untagged(part.image);

  if (data === null || policy.accepts.has('image')) return null;

  return replaceMedia(data, { mediaType: part.mediaType ?? 'image', filename: undefined, upload: null }, policy);
}

async function sanitizeFilePart(part: FilePart, policy: AttachmentPolicy): Promise<TextPart | null> {
  const data = untagged(part.data);

  // The provider's own handle to a file it already holds: nothing here to read or store.
  if (data === null) return null;
  const modality = mediaModalityFor(part.mediaType);
  const upload = uploadOf(part);

  if (modality !== null && policy.accepts.has(modality)) {
    return modality !== 'image' && oversizeForInlineDocument(data)
      ? replaceMedia(data, { mediaType: part.mediaType, filename: part.filename, upload }, policy)
      : null;
  }

  if (isTextMediaType(part.mediaType)) return inlineOrStoreText(data, part, policy);

  return replaceMedia(data, { mediaType: part.mediaType, filename: part.filename, upload }, policy);
}

async function sanitizeTextPart(part: TextPart, policy: AttachmentPolicy): Promise<TextPart | null> {
  const replacement = await sanitizeUserText(part.text, policy);

  return replacement === null ? null : { ...part, text: replacement };
}

/** Byte-stable, so a pasted document does not move the prompt-cache prefix. Null within budget. */
async function sanitizeUserText(text: string, policy: AttachmentPolicy): Promise<string | null> {
  const bytes = new TextEncoder().encode(text);

  if (bytes.length <= INLINE_TEXT_MAX_BYTES) return null;
  const path = await storeAttachment(policy.vfs, OFFLOADED_DIR, bytes, 'text/plain');
  const head = text.slice(0, PASTED_TEXT_PREVIEW_CHARS);
  policy.budget?.recordSpill({
    producer: 'pasted_text', omitted: text.length - head.length, referenced: true,
  });

  return `[Pasted text (${bytes.length} bytes) saved to ${path} (read or slice it with your file tools; ` +
    `oversize: name ${path} in the message of a lifetime:"task" agents hire so that agent reads it instead of you). The first ${head.length} chars follow.]\n\n${head}`;
}

/** Sized without decoding: base64 is ~4/3 of the bytes; remote URLs have no local payload. */
function oversizeForInlineDocument(data: DataContent | URL): boolean {
  const bytes = estimatePayloadBytes(data);

  return bytes !== null && bytes > OVERSIZE_ACCEPTED_DOC_MAX_BYTES;
}

function estimatePayloadBytes(data: DataContent | URL): number | null {
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

async function inlineOrStoreText(data: DataContent | URL, file: FilePart, policy: AttachmentPolicy): Promise<TextPart> {
  const payload = decodePayload(data);
  const upload = uploadOf(file);

  if (payload.kind === 'remote') return remoteReference(payload.url, file.mediaType, file.filename);

  if (payload.bytes.length < INLINE_TEXT_MAX_BYTES) {
    const name = file.filename ?? 'attachment.txt';
    const text = new TextDecoder().decode(payload.bytes);
    const saved = upload === null ? '' : ` saved to ${onThisMachine(upload, policy.planes)},`;

    return {
      type: 'text',
      text: `[Attachment ${name} (${file.mediaType}, ${payload.bytes.length} bytes)${saved} inlined below]\n\n${text}`,
    };
  }

  return storeAndReference(payload.bytes, { mediaType: file.mediaType, filename: file.filename, upload }, policy);
}

/** What a part's bytes are: their type, the name they came with, and the upload they were saved as, if any. */
interface Carried {
  readonly mediaType: string;
  readonly filename: string | undefined;
  readonly upload: string | null;
}

async function replaceMedia(data: DataContent | URL, carried: Carried, policy: AttachmentPolicy): Promise<TextPart> {
  const payload = decodePayload(data);

  if (payload.kind === 'remote') return remoteReference(payload.url, carried.mediaType, carried.filename);

  return storeAndReference(payload.bytes, carried, policy);
}

/** An upload is named where it was saved, and never stored again; any other bytes are offloaded by their digest. */
async function storeAndReference(bytes: Uint8Array, carried: Carried, policy: AttachmentPolicy): Promise<TextPart> {
  const path = carried.upload === null
    ? await storeAttachment(policy.vfs, OFFLOADED_DIR, bytes, carried.mediaType)
    : onThisMachine(carried.upload, policy.planes);

  policy.budget?.recordSpill({ producer: 'attachment', omitted: bytes.length, referenced: true });
  const name = carried.filename ?? path.slice(path.lastIndexOf('/') + 1);

  return {
    type: 'text',
    text: `[Attachment ${name} (${carried.mediaType}, ${bytes.length} bytes) saved to ${path} (read it with your file tools)]`,
  };
}

/** An upload the model takes inline, named where it was saved. */
function uploadNote(part: FilePart, path: string): TextPart {
  return { type: 'text', text: `[Attachment ${part.filename ?? path} (${part.mediaType}) saved to ${path}, shown below]` };
}

/** Where a path of the workspace's own tree sits on this machine: the same path on the cloud, under the space locally. */
function onThisMachine(path: string, planes: PathPlanes | undefined): string {
  return planes === undefined ? path : resolvePath(vfsReference(path), planes).absolute;
}

/** Where an admitted file part says its upload was saved ({@link saveUploads}); a key no provider reads. */
const UploadedSchema = v.object({ kinu: v.object({ upload: v.string() }) });

function uploadOf(part: FilePart): string | null {
  const read = v.safeParse(UploadedSchema, part.providerOptions);

  return read.success ? read.output.kinu.upload : null;
}

/** Copies of one name an upload may take before it is refused: `name (2).ext` up to this. */
const UPLOAD_COPIES = 1_000;

/** NAME_MAX, in UTF-8 bytes, less room for a copy's ` (1000)`. */
const UPLOAD_NAME_BYTES = 248;

/**
 * The owner's files, each saved once as the words they came with are admitted: under {@link UPLOADS_ROOT} by the name it
 * came with, as `name (2).ext` when that name holds other bytes, and to the same file when it holds these. Each file
 * part then says where (`providerOptions.kinu.upload`), which the sanitizer names and never stores again. A part with no
 * bytes here (a URL, a provider's own handle) is left as it is.
 */
export function saveUploads(message: ModelMessage, files: Pick<AttachmentPolicy, 'vfs' | 'planes'>): Promise<ModelMessage> {
  if (message.role !== 'user' || !Array.isArray(message.content)) return Promise.resolve(message);
  const offered: readonly UserPart[] = message.content;

  return settle(Effect.gen(function* () {
    let changed = false;
    const content: UserPart[] = [];

    for (const part of offered) {
      const data = part.type === 'file' && uploadOf(part) === null ? untagged(part.data) : null;
      const payload = data === null ? null : decodePayload(data);

      if (part.type !== 'file' || payload === null || payload.kind === 'remote') {
        content.push(part);
        continue;
      }

      const upload = yield* saveUpload(files, uploadName(part.filename, part.mediaType), payload.bytes);
      content.push({ ...part, providerOptions: { ...part.providerOptions, kinu: { upload } } });
      changed = true;
    }

    return changed ? { ...message, content } : message;
  }));
}

/** Its own name, with no folder, separator or control character left in it, cut to fit; `upload.<ext>` when nothing is. */
function uploadName(filename: string | undefined, mediaType: string): string {
  const last = (filename ?? '').split(/[/\\]/u).at(-1) ?? '';
  const name = Array.from(last).filter((character) => (character.codePointAt(0) ?? 0) > 0x1f && character !== '\u007f').join('').trim();

  if (name === '' || name === '.' || name === '..') return `upload.${extensionFor(mediaType)}`;
  const encoder = new TextEncoder();

  if (encoder.encode(name).length <= UPLOAD_NAME_BYTES) return name;
  const { stem, extension } = splitExtension(name);
  let cut = stem;

  while (cut !== '' && encoder.encode(`${cut}${extension}`).length > UPLOAD_NAME_BYTES) cut = Array.from(cut).slice(0, -1).join('');

  return `${cut}${extension}`;
}

function splitExtension(name: string): { readonly stem: string; readonly extension: string } {
  const dot = name.lastIndexOf('.');

  return dot > 0 ? { stem: name.slice(0, dot), extension: name.slice(dot) } : { stem: name, extension: '' };
}

/** `bytes` under {@link UPLOADS_ROOT} as `name`, or as `name (2).ext`, `(3)`… past names holding other bytes: the
 *  workspace's path of the file holding them. */
function saveUpload({ vfs, planes }: Pick<AttachmentPolicy, 'vfs' | 'planes'>, name: string, bytes: Uint8Array): Effect.Effect<string, KinuError> {
  const { stem, extension } = splitExtension(name);

  return Effect.gen(function* () {
    for (let copy = 1; copy <= UPLOAD_COPIES; copy += 1) {
      const path = `${UPLOADS_ROOT}/${copy === 1 ? name : `${stem} (${String(copy)})${extension}`}`;
      const here = onThisMachine(path, planes);

      if (!(yield* Effect.promise(() => exists(vfs, here)))) {
        yield* Effect.promise(() => madeDirectory(vfs, onThisMachine(UPLOADS_ROOT, planes), 'creating the uploads directory'));
        yield* Effect.promise(async () => vfs.writeFile(here, bytes));

        return path;
      }

      if (yield* Effect.promise(() => holdsBytes(vfs, here, bytes))) return path;
    }

    return yield* new KinuError('bad_input', `${String(UPLOAD_COPIES)} uploads are named ${name} already: rename the file to upload it`);
  });
}

async function madeDirectory(vfs: VFS, directory: string, doing: string): Promise<void> {
  try {
    await vfs.mkdir(directory, { recursive: true });
  } catch (err) {
    if (classify({ cause: err }) !== 'eexist') throw toKinuError({ doing, cause: err, otherwise: 'io' });
  }
}

/**
 * `bytes` under `directory` by content (`<sha256>.<ext>`), the path returned once durable: the one attachment store,
 * for a part the model cannot take and for one compaction moves out. Reuse verifies the bytes: an existing path
 * (truncated write, agent-written file) is not proof of content.
 */
export async function storeAttachment(vfs: VFS, directory: string, bytes: Uint8Array, mediaType: string): Promise<string> {
  const path = `${directory}/${sha256Hex(bytes)}.${extensionFor(mediaType)}`;

  if (await holdsBytes(vfs, path, bytes)) return path;
  await madeDirectory(vfs, directory, 'creating the offloaded spill directory');
  await vfs.writeFile(path, bytes);

  return path;
}

/** Absent is the ordinary first spill; mismatched bytes are rewritten. */
async function holdsBytes(vfs: VFS, path: string, bytes: Uint8Array): Promise<boolean> {
  if (!(await exists(vfs, path))) return false;
  const stored = await vfs.readFile(path);
  // Narrowed by class, as prompting/agents-md.ts does for the same VFS return.
  const existing = stored instanceof Uint8Array ? stored : new TextEncoder().encode(stored);

  if (existing.length !== bytes.length) return false;

  for (let i = 0; i < bytes.length; i++) {
    if (existing[i] !== bytes[i]) return false;
  }

  return true;
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

/** A part's payload as bytes; null for a remote URL, which has none here. */
export function attachmentBytes(tagged: FilePart['data']): Uint8Array | null {
  const data = untagged(tagged);
  const payload = data === null ? null : decodePayload(data);

  return payload?.kind === 'bytes' ? payload.bytes : null;
}

function decodePayload(data: DataContent | URL): DecodedPayload {
  if (data instanceof URL) return { kind: 'remote', url: data.toString() };

  if (data instanceof Uint8Array) return { kind: 'bytes', bytes: data };

  if (data instanceof ArrayBuffer) return { kind: 'bytes', bytes: new Uint8Array(data) };

  if (data.startsWith('data:')) return { kind: 'bytes', bytes: decodeDataUrl(data) };

  if (/^https?:\/\//.test(data)) return { kind: 'remote', url: data };

  return { kind: 'bytes', bytes: decodeBase64OrText(data) };
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const header = comma === -1 ? dataUrl : dataUrl.slice(0, comma);
  const payload = comma === -1 ? '' : dataUrl.slice(comma + 1);

  if (header.includes(';base64')) return decodeBase64OrText(payload);

  return new TextEncoder().encode(decodeURIComponent(payload));
}

/** Invalid base64 is treated as UTF-8 so a malformed part cannot break the turn. */
function decodeBase64OrText(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return bytes;
  } catch (error) {
    diagnostics.event('attachment.base64_decode_fallback', { error: renderThrownChain({ cause: error }) });

    return new TextEncoder().encode(value);
  }
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
