import { exists, type VFS } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * What the model is shown of a message's files. A file a person sends is uploaded first and named by its path
 * ({@link uploadPart}); its bytes are read from the file plane here, each step, where the model accepts its type and it
 * fits ({@link documentFits}), and it is named by its path where not. A part carrying bytes (history stored before
 * uploads were references, a tool's file) is replaced, where the model cannot take it, by a reference: its upload's
 * path where it was saved as one, else a content-addressed copy in the hidden offloaded directory. Applied to the whole
 * history each turn, never mutating it; byte-stable (prompt-cache prefix); message count never changes, so
 * index-anchored consumers stay valid.
 */

import type { AssistantModelMessage, DataContent, FilePart, ImagePart, ModelMessage, TextPart, UserModelMessage } from 'ai';
import { untagged } from '../utils/file-data';
import type { PromptFile } from '../types/backend-host';
import { stepContextLimit, type ModelWindow } from '../context-window';
import { documentTokens } from './document-tokens';
import { PLATFORM_LIMITS } from '../platform-limits';

import type { ModelInputModality } from '../providers/types';
import { servingRoute } from '../providers/serving-route';
import { SPILL_DIRS, type TurnContextBudget } from '../context-budget';
import { diagnostics, KinuError, renderThrownChain, settle, tolerateAsync } from '../obs/index';
import { Effect } from 'effect';
import { UPLOADS_ROOT } from '../vfs/workspace-path';
import { resolvePath, vfsReference, type PathPlanes } from '../vfs/resolve';
import * as v from 'valibot';
import { sha256Hex } from '../safety/argument-digest';
import { ensureDir, fileHolds, publishContent } from '../utils/vfs-helpers';

/** Every model accepts text. */
export type MediaModality = Exclude<ModelInputModality, 'text'>;

export interface AttachmentPolicy {
  readonly accepts: ReadonlySet<MediaModality>;
  readonly vfs: VFS;
  /** The serving model's window, out of whose step allocation documents shown inline are spent; unknown, all fit. */
  readonly window?: ModelWindow;
  /** Where the workspace's own paths sit on this machine, by which an upload is named; absent, they are its own. */
  readonly planes?: PathPlanes;
  /** Counters show how often real traffic crosses the spill threshold. */
  readonly budget?: TurnContextBudget;
}

/** Other providers use the OpenAI-compatible schema, where a `type:"file"` part is a guaranteed 400. */
const PDF_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'claude', 'openai', 'codex', 'chatgpt']);

/** The serving API's ceiling (`servingRoute`) ∩ catalog input modalities; the ceiling alone when the catalog has no entry. */
export function acceptedMediaForModel(opts: {
  spec?: string;
  catalogInputModalities?: readonly ModelInputModality[];
}): ReadonlySet<MediaModality> {
  const ceiling: ReadonlySet<MediaModality> = PDF_CAPABLE_PROVIDERS.has(servingRoute(opts.spec ?? '')?.provider ?? '')
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

/**
 * Whether a document the model accepts is shown inline: it is, while the documents shown so far, oldest first, and it fit
 * the step's allocation (`stepContextLimit`), spent as every request-bound producer spends it, priced by
 * `documentTokens`; past that it goes by its path, for the file tools. Oldest first keeps a document once shown in
 * place: a newer one never pushes it out of the cached prefix. Images always stay inline: no read-back recipe exists.
 */
function documentFits(spent: { tokens: number }, mediaType: string, bytes: Uint8Array, policy: AttachmentPolicy): boolean {
  const tokens = documentTokens(mediaType, bytes);
  const room = policy.window === undefined ? Number.POSITIVE_INFINITY : stepContextLimit(policy.window);

  if (spent.tokens + tokens > room) return false;
  spent.tokens += tokens;

  return true;
}

const OFFLOADED_DIR = SPILL_DIRS.offloaded;

/** Copy-on-write per message, and of the list from its first changed message: untouched messages keep referential
 *  identity, and an untouched history is returned as given. The turn's history as it opens: its files shown, and words
 *  past the inline limit (a pasted document) spilled to a file. */
export function sanitizeAttachmentsForModel(messages: readonly ModelMessage[], policy: AttachmentPolicy): Promise<readonly ModelMessage[]> {
  return showModel(messages, { policy, spent: { tokens: 0 }, spills: true });
}

/**
 * A step's request with each file it names shown, and every word as it is: a step also carries the runtime's own
 * user-role blocks (the skills a mid-turn message activates, the turn's state), which are instructions the model
 * reads, never a person's pasted document to spill.
 */
export function showFilesForModel(messages: readonly ModelMessage[], policy: AttachmentPolicy): Promise<readonly ModelMessage[]> {
  return showModel(messages, { policy, spent: { tokens: 0 }, spills: false });
}

/**
 * A person's words as the model is shown them, each past the inline limit spilled to a file exactly as the history pass
 * spills it when the turn after opens, so words typed mid-turn read the same in the step they land at and in every
 * later request. Their files are left to the step's own pass.
 */
export async function spillPastedWords(message: ModelMessage, policy: Pick<AttachmentPolicy, 'vfs' | 'budget'>): Promise<ModelMessage> {
  if (message.role !== 'user') return message;

  if (!Array.isArray(message.content)) {
    const replacement = await sanitizeUserText(message.content, policy);

    return replacement === null ? message : { ...message, content: replacement };
  }

  let changed = false;
  const parts: UserPart[] = [];

  for (const part of message.content) {
    const replacement = part.type === 'text' ? await sanitizeTextPart(part, policy) : null;

    if (replacement !== null) changed = true;
    parts.push(replacement ?? part);
  }

  return changed ? { ...message, content: parts } : message;
}

async function showModel(messages: readonly ModelMessage[], shown: Shown): Promise<readonly ModelMessage[]> {
  let out: ModelMessage[] | undefined;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const sanitized = mayCarryAttachments(message) ? await sanitizeMessage(message, shown) : message;

    if (sanitized !== message) out ??= messages.slice(0, index);
    out?.push(sanitized);
  }

  return out ?? messages;
}

/** Only a file part can carry an attachment: the rest of a long turn's answers pass without a copy or an await. */
function mayCarryAttachments(message: ModelMessage): boolean {
  return message.role === 'user' || (message.role === 'assistant' && Array.isArray(message.content) && message.content.some((part) => part.type === 'file'));
}

/** A request's policy, the documents it has shown inline so far, oldest first, and whether long words spill. */
interface Shown {
  readonly policy: AttachmentPolicy;
  readonly spent: { tokens: number };
  readonly spills: boolean;
}

async function sanitizeMessage(message: ModelMessage, shown: Shown): Promise<ModelMessage> {
  const { policy } = shown;

  if (message.role === 'assistant' && Array.isArray(message.content)) return sanitizeAssistantMessage(message, message.content, shown);

  if (message.role !== 'user') return message;

  if (Array.isArray(message.content)) return sanitizeUserMessage(message, message.content, shown);

  if (!shown.spills) return message;
  const replacement = await sanitizeUserText(message.content, policy);

  return replacement === null ? message : { ...message, content: replacement };
}

type UserPart = Exclude<UserModelMessage['content'], string>[number];

type AssistantPart = Exclude<AssistantModelMessage['content'], string>[number];

async function sanitizeUserMessage(
  message: UserModelMessage,
  content: readonly UserPart[],
  shown: Shown,
): Promise<UserModelMessage> {
  const { policy } = shown;
  let changed = false;
  const parts: UserPart[] = [];

  for (const offered of content) {
    const upload = offered.type === 'file' ? uploadOf(offered) : null;
    const read = offered.type === 'file' && upload !== null ? await uploadedFile(offered, upload, policy) : offered;

    // A note in its place: the upload it named is gone.
    if (read !== offered && read.type === 'text') {
      parts.push(read);
      changed = true;
      continue;
    }

    const replacement = await sanitizePart(read, shown);

    // An upload the model takes as it is still names where it was saved, so the agent can work on the file; named once,
    // as its path gives way to its bytes, so a message already shaped passes through a later step unchanged.
    if (replacement === null && upload !== null && read.type === 'file' && read !== offered) parts.push(uploadNote(read, onThisMachine(upload, policy.planes)));

    if (replacement !== null || read !== offered) changed = true;
    parts.push(replacement ?? read);
  }

  return changed ? { ...message, content: parts } : message;
}

/**
 * An upload's part with its bytes, read from the file plane where the part names them by path (each step: the message
 * never holds them); as it is where it carries its bytes (history stored before uploads were references, never written
 * now); a note where the file is no longer there.
 */
async function uploadedFile(part: FilePart, upload: string, policy: AttachmentPolicy): Promise<FilePart | TextPart> {
  if (untagged(part.data) !== upload) return part;
  const here = onThisMachine(upload, policy.planes);
  const digest = digestOf(part);
  // The bytes it was attached with, pinned; a part from before pinning reads the file at its path.
  const source = digest === null ? here : onThisMachine(pinnedUpload(digest, part.mediaType), policy.planes);
  const stat = await tolerateAsync(async () => await policy.vfs.stat(source), 'enoent') ?? null;
  const gone: TextPart = { type: 'text', text: `[Attachment ${part.filename ?? upload} (${part.mediaType}) was saved to ${here}; it is no longer there]` };

  if (stat === null) return gone;
  const modality = mediaModalityFor(part.mediaType);
  const shown = (modality !== null && policy.accepts.has(modality)) || (isTextMediaType(part.mediaType) && stat.size < INLINE_TEXT_MAX_BYTES);

  // Not shown inline: named by its path and size, its bytes never read.
  if (!shown) return referenceTo({ mediaType: part.mediaType, filename: part.filename, upload, digest }, stat.size, here, policy);
  const bytes = await readUpload(policy.vfs, source, stat);

  return bytes === undefined ? gone : { ...part, data: bytes };
}

async function sanitizeAssistantMessage(
  message: AssistantModelMessage,
  content: readonly AssistantPart[],
  shown: Shown,
): Promise<AssistantModelMessage> {
  let changed = false;
  const parts: AssistantPart[] = [];

  for (const part of content) {
    const replacement = part.type === 'file' ? await sanitizeFilePart(part, shown) : null;

    if (replacement) changed = true;
    parts.push(replacement ?? part);
  }

  return changed ? { ...message, content: parts } : message;
}

/** Only the three carrier kinds can hold an attachment. */
async function sanitizePart(part: UserPart, shown: Shown): Promise<TextPart | null> {
  if (part.type === 'image') return await sanitizeImagePart(part, shown);

  if (part.type === 'file') return await sanitizeFilePart(part, shown);

  if (part.type === 'text') return shown.spills ? await sanitizeTextPart(part, shown.policy) : null;

  return null;
}

async function sanitizeImagePart(part: ImagePart, shown: Shown): Promise<TextPart | null> {
  const { policy } = shown;

  if (part.mediaType !== undefined && !RASTER_IMAGES.has(part.mediaType)) {
    return sanitizeFilePart({ type: 'file', data: part.image, mediaType: part.mediaType }, shown);
  }

  const data = untagged(part.image);

  if (data === null || policy.accepts.has('image')) return null;

  return replaceMedia(data, { mediaType: part.mediaType ?? 'image', filename: undefined, upload: null, digest: null }, policy);
}

async function sanitizeFilePart(part: FilePart, shown: Shown): Promise<TextPart | null> {
  const { policy } = shown;
  const data = untagged(part.data);

  // The provider's own handle to a file it already holds: nothing here to read or store.
  if (data === null) return null;
  const modality = mediaModalityFor(part.mediaType);
  const upload = uploadOf(part);

  if (modality !== null && policy.accepts.has(modality)) {
    const payload = modality === 'image' ? null : decodePayload(data);

    return payload?.kind === 'bytes' && !documentFits(shown.spent, part.mediaType, payload.bytes, policy)
      ? storeAndReference(payload.bytes, { mediaType: part.mediaType, filename: part.filename, upload, digest: digestOf(part) }, policy)
      : null;
  }

  if (isTextMediaType(part.mediaType)) return inlineOrStoreText(data, part, policy);

  return replaceMedia(data, { mediaType: part.mediaType, filename: part.filename, upload, digest: digestOf(part) }, policy);
}

async function sanitizeTextPart(part: TextPart, policy: Pick<AttachmentPolicy, 'vfs' | 'budget'>): Promise<TextPart | null> {
  const replacement = await sanitizeUserText(part.text, policy);

  return replacement === null ? null : { ...part, text: replacement };
}

/** Byte-stable, so a pasted document does not move the prompt-cache prefix. Null within budget. */
async function sanitizeUserText(text: string, policy: Pick<AttachmentPolicy, 'vfs' | 'budget'>): Promise<string | null> {
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

  return storeAndReference(payload.bytes, { mediaType: file.mediaType, filename: file.filename, upload, digest: digestOf(file) }, policy);
}

/** What a part's bytes are: their type, the name they came with, the upload they were saved as, if any, and the digest
 *  they were pinned as when attached (`placeUpload`), if they were. */
interface Carried {
  readonly mediaType: string;
  readonly filename: string | undefined;
  readonly upload: string | null;
  readonly digest: string | null;
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

  return referenceTo(carried, bytes.length, path, policy);
}

/** A file named where it is kept, by its size, for the agent's file tools. */
function referenceTo(carried: Carried, size: number, path: string, policy: AttachmentPolicy): TextPart {
  policy.budget?.recordSpill({ producer: 'attachment', omitted: size, referenced: true });
  const name = carried.filename ?? path.slice(path.lastIndexOf('/') + 1);
  const said = `[Attachment ${name} (${carried.mediaType}, ${String(size)} bytes)`;

  // A pinned upload is two files: the attachment as it was sent, which nothing rewrites, and the file anyone may edit
  // since. Both paths and the size follow from the part and its digest alone, so the note never changes.
  if (carried.upload !== null && carried.digest !== null) {
    const sent = onThisMachine(pinnedUpload(carried.digest, carried.mediaType), policy.planes);

    return { type: 'text', text: `${said} as sent is at ${sent}; the editable file is ${path}, which may have changed since (read either with your file tools)]` };
  }

  return { type: 'text', text: `${said} saved to ${path} (read it with your file tools)]` };
}

/** An upload the model takes inline, named where it was saved. */
function uploadNote(part: FilePart, path: string): TextPart {
  return { type: 'text', text: `[Attachment ${part.filename ?? path} (${part.mediaType}) saved to ${path}, shown below]` };
}

/** Where a path of the workspace's own tree sits on this machine: the same path on the cloud, under the space locally. */
function onThisMachine(path: string, planes: PathPlanes | undefined): string {
  return planes === undefined ? path : resolvePath(vfsReference(path), planes).absolute;
}

/** Where a file part says its upload is ({@link uploadPart}); a key no provider reads. */
const UploadedSchema = v.object({ kinu: v.object({ upload: v.string(), digest: v.optional(v.string()) }) });

function uploadOf(part: FilePart): string | null {
  const read = v.safeParse(UploadedSchema, part.providerOptions);

  return read.success ? read.output.kinu.upload : null;
}

/** The digest of the bytes a part's upload held when it was attached (`placeUpload`); null for a part from before. */
function digestOf(part: FilePart): string | null {
  return digestOfUiPart({ providerMetadata: part.providerOptions });
}

/** Uploads read lately, per file plane: every turn's history names the same files again. */
const READ_UPLOADS = new WeakMap<VFS, Map<string, { readonly mtimeMs: number; readonly size: number; readonly bytes: Uint8Array }>>();

/** The bytes kept per file plane, oldest dropped first: one upload's bound (`upload.file_bytes`), what the actor holds
 *  of a single upload as it lands. A file past it is read each time it is shown. */
const READ_UPLOADS_BYTES = PLATFORM_LIMITS['upload.file_bytes'].value;

/** An upload's bytes, read again only when its size or time changed since; undefined where it is gone. */
async function readUpload(vfs: VFS, path: string, stat: { readonly mtimeMs: number; readonly size: number }): Promise<Uint8Array | undefined> {
  const kept = READ_UPLOADS.get(vfs) ?? new Map();

  READ_UPLOADS.set(vfs, kept);
  const known = kept.get(path);

  if (known !== undefined && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.bytes;
  const read = await tolerateAsync(async () => await vfs.readFile(path), 'enoent');

  if (read === undefined) return undefined;
  const bytes = typeof read === 'string' ? new TextEncoder().encode(read) : read;

  kept.delete(path);

  if (bytes.byteLength > READ_UPLOADS_BYTES) return bytes;
  kept.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, bytes });
  let held = [...kept.values()].reduce((sum, each) => sum + each.bytes.byteLength, 0);

  for (const [oldest, each] of kept) {
    if (held <= READ_UPLOADS_BYTES) break;
    kept.delete(oldest);
    held -= each.bytes.byteLength;
  }

  return bytes;
}

/** The digest a chat's file part names (`kinu.digest`): the bytes it was attached with; null where it names none. */
export function digestOfUiPart(part: { readonly providerMetadata?: unknown }): string | null {
  const tagged = v.safeParse(UploadedSchema, part.providerMetadata);

  return tagged.success ? tagged.output.kinu.digest ?? null : null;
}

/**
 * The upload a chat's file part names: its `kinu.upload`, or, for a part that kept only its address (a carried opening,
 * a reverted message), the path that address is or reads from the files route. Null for a part naming no upload.
 */

export function uploadOfUiPart(part: { readonly url: string; readonly providerMetadata?: unknown }): string | null {
  const tagged = v.safeParse(UploadedSchema, part.providerMetadata);

  if (tagged.success) return tagged.output.kinu.upload;
  const path = part.url.startsWith('/api/workspaces/') ? new URL(part.url, 'http://kinu.local').searchParams.get('path') : part.url;

  return path !== null && path.startsWith(`${UPLOADS_ROOT}/`) ? path : null;
}

/** A sent file as its message holds it: named by its upload's path, which also stands in its bytes' place. */
export function uploadPart(file: PromptFile): FilePart {
  return {
    type: 'file', data: file.path, mediaType: file.mediaType, filename: file.filename,
    providerOptions: { kinu: { upload: file.path, ...(file.digest !== undefined && { digest: file.digest }) } },
  };
}

/** An upload as it was kept: its path, the file to work on, and the digest of the bytes it held then. */
export interface KeptUpload {
  readonly path: string;
  readonly digest: string;
}

/** The offloaded store beside the uploads: under their root, so it resolves on every runtime as an upload does. */
const PINNED_DIR = `${UPLOADS_ROOT}/${OFFLOADED_DIR}`;

/**
 * Where the bytes an upload held when it was attached are pinned: the offloaded store's content-addressed copy
 * (`storeAttachment`, kept by digest, hidden in the Files tab), which nothing rewrites. Every later turn shows a
 * message's file from here, whatever becomes of the file at its path, so history and the cached prefix never move. A
 * workspace path; `onThisMachine` places it.
 */
export function pinnedUpload(digest: string, mediaType: string): string {
  return `${PINNED_DIR}/${digest}.${extensionFor(mediaType)}`;
}

/** Copies of one name an upload may take before it is refused: `name (2).ext` up to this. */
const UPLOAD_COPIES = 1_000;

/** NAME_MAX, in UTF-8 bytes, less room for a copy's ` (1000)`. */
const UPLOAD_NAME_BYTES = 248;

/**
 * A person's file, kept as an upload lands (the files route's `uploads=` form): under {@link UPLOADS_ROOT} by the name
 * it came with ({@link uploadName}), as `name (2).ext` when that name holds other bytes, and the same file when it holds
 * these. Answers the workspace path its message then names.
 */
export function placeUpload(files: Pick<AttachmentPolicy, 'vfs' | 'planes'>, filename: string, mediaType: string, bytes: Uint8Array): Promise<KeptUpload> {
  const bound = PLATFORM_LIMITS['upload.file_bytes'].value;

  // One bound for every upload, wherever it lands: the files route's, the CLI's, an ACP client's.
  if (bytes.byteLength > bound) {
    return settle(Effect.fail(new KinuError('bad_input', `${filename} is ${String(bytes.byteLength)} bytes; one upload carries at most ${String(bound)} (upload.file_bytes).`)));
  }

  // Kept at its name to work on, and pinned by its digest for every message that names it.
  return settle(Effect.gen(function* () {
    const path = yield* saveUpload(files, uploadName(filename, mediaType), bytes);

    yield* Effect.promise(async () => await storeAttachment(files.vfs, onThisMachine(PINNED_DIR, files.planes), bytes, mediaType));

    return { path, digest: sha256Hex(bytes) };
  }));
}

/**
 * Its own name spelled as it reads, so the path its agent types back opens it: composed, each space a plain space (a
 * macOS screenshot's narrow one before its AM was typed back as one, #124), with no folder, separator, control or
 * invisible character left in it, cut to fit; `upload.<ext>` when nothing is.
 */
function uploadName(filename: string | undefined, mediaType: string): string {
  const last = (filename ?? '').split(/[/\\]/u).at(-1) ?? '';
  const name = last.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\p{Z}/gu, ' ').trim();

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
        yield* Effect.promise(() => ensureDir(vfs, onThisMachine(UPLOADS_ROOT, planes)));
        yield* Effect.promise(async () => vfs.writeFile(here, bytes));

        return path;
      }

      if (yield* Effect.promise(() => fileHolds(vfs, here, bytes))) return path;
    }

    return yield* new KinuError('bad_input', `${String(UPLOAD_COPIES)} uploads are named ${name} already: rename the file to upload it`);
  });
}

/**
 * `bytes` under `directory` by content (`<sha256>.<ext>`), the path returned once durable: the one attachment store,
 * for a part the model cannot take and for one compaction moves out. Reuse verifies the bytes: an existing path
 * (truncated write, agent-written file) is not proof of content.
 */
export async function storeAttachment(vfs: VFS, directory: string, bytes: Uint8Array, mediaType: string): Promise<string> {
  const path = `${directory}/${sha256Hex(bytes)}.${extensionFor(mediaType)}`;

  // Mismatched bytes are the spill's own to repair: rewritten.
  await publishContent(vfs, { directory, path, bytes, otherBytes: 'rewrite' });

  return path;
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
