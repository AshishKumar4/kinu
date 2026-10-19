/**
 * The file operations served over `rt.toolFiles`. A write or edit is refused until the agent has read what it would
 * replace, here or by the native tool: one ledger for both.
 */
import { readText, type VFS, type VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
import { isVfsError, VfsError, type VfsErrorCode } from '@nimbus-sh/core/vfs/vfs-error.js';
import { normalizePath } from '@nimbus-sh/core/vfs/composite.js';
import * as v from 'valibot';
import { addressingHint, formatPath, resolvePath, type PathPlanes } from '../vfs/resolve';
import { writeConditionally, type ObservedFile, type WriteGuarantee } from '../vfs/conditional-write';
import type { CheckpointFiles, Memory, VfsWriteReport } from '../types/primitives';
import type { TurnContextBudget } from '../context-budget';
import { ensureDir, vfsDirname } from '../utils/vfs-helpers';
import { memoryIndexPath } from '../memory/note';
import { applyFileEdits, formatFileSlice, FILE_READ_LINE_CHARS, FILE_READ_LINES, FILE_READ_MAX_CHARS, FILE_REFUSAL_REASONS, type FileEdit } from './file-edit';
import { FileRefusalError } from '../types/file-edits';
import { readFileHead, scanFileWindow, type ScannedFile } from './file-scan';
import type { TurnFileLedger, FileEditOutcomeReason, FileSeenNeed } from '../vfs/file-ledger';
import { KinuError, renderThrownChain, tolerateAsync } from '../obs/index';
import { requireBuild } from '../execution/work-mode';
import { uncheckpointedSentence } from '../execution/exec-result';
import { RESIDENT_TEXT_MAX_BYTES, type VfsMountRouting } from '../vfs/mounts';
import { rasterImage } from '../utils/raster-image';
import { bytesToBase64 } from '../utils/base64';
import { imageCarrier, type ImageCarrier } from '../types/tool-images';
import type { CodemodeProvider } from '../types/codemode';
import { serve, type Served } from '../operations/operation';
import { codemodeNamespace, nativeTool } from './operation-surfaces';
import { withClampedToolResult } from './clamp';
import { BUILTIN_TOOL_DESCRIPTIONS } from './registry';
import type { Tool } from 'ai';
import { FILE, type SlateBuildNoteSchema } from '../operations/file';
import { SLATES_ROOT } from '../vfs/workspace-path';
import type { SlateCallResult } from '../slates/rpc';

/** Most names one `list` returns; matches `tools/db-codemode.ts` SELECT_LIMIT_MAX. */
const FILE_LIST_MAX_ENTRIES = 1_000;

/** Most characters of names one `list` returns, for a directory of few enormous entries. */
const FILE_LIST_MAX_CHARS = RESIDENT_TEXT_MAX_BYTES;

/** Most bytes one `search` reads of the scanned file (same budget as `vfs/mounts.ts`). */
const FILE_SEARCH_MAX_BYTES = RESIDENT_TEXT_MAX_BYTES;

/** Most bytes of an image one `read` shows: 5 MB as base64, Anthropic's ceiling on Bedrock and Google Cloud. */
const IMAGE_READ_MAX_BYTES = 3_750_000;

/** Which reads check for an image; the header decides. */
const RASTER_PATH = /\.(?:png|jpe?g|gif|webp)$/iu;

/** One page of a listing from `offset`; `truncated` is absent on a whole listing, so its presence is the fact. */
function boundListing(path: string, entries: readonly string[], offset: number): {
  path: string; entries: string[]; truncated?: { shown: number; total: number; next: number };
} {
  const shown: string[] = [];
  let chars = 0;

  for (const entry of entries.slice(offset)) {
    if (shown.length >= FILE_LIST_MAX_ENTRIES || chars + entry.length > FILE_LIST_MAX_CHARS) break;
    chars += entry.length;
    shown.push(entry);
  }

  const next = offset + shown.length;

  return offset === 0 && next >= entries.length
    ? { path, entries: shown }
    : { path, entries: shown, truncated: { shown: shown.length, total: entries.length, next } };
}

/** The read-before-write gate's refusal and reason, or both null when the operation may proceed. */
interface GateVerdict {
  readonly refusal: string | null;
  readonly reason: FileEditOutcomeReason | null;
}

/** Why a `file` call failed: the ledger's reasons plus malformed arguments, which never
 *  became an edit attempt and must not inflate `attempts`. */
type FileToolFailureReason = FileEditOutcomeReason | 'bad_input';

/** Fail at the operation that made the decision; callers choose the native or namespace boundary. */
function failure(reason: FileToolFailureReason, error: string): never {
  if (v.is(v.picklist(FILE_REFUSAL_REASONS), reason)) throw new FileRefusalError(reason, error);
  throw new KinuError(reason, error);
}

/** Which refusal a VFS errno is: absent path, permission wall, or filesystem failure. */
function editOutcomeReason(code: VfsErrorCode): FileEditOutcomeReason {
  if (code === 'ENOENT') return 'missing';

  if (code === 'EACCES' || code === 'EPERM') return 'denied';

  return 'io';
}

/** Why a file operation failed: its refusal, and the words the model reads. */
interface VfsFailure {
  readonly reason: FileEditOutcomeReason;
  readonly error: string;
}

function vfsFailure(planes: PathPlanes, input: { error: unknown }, action: string, path: string): VfsFailure {
  const err = input.error;

  if (err instanceof FileRefusalError) return { reason: err.verdict, error: err.message };

  if (err instanceof KinuError) {
    if (err.code === 'denied' || err.code === 'missing' || err.code === 'io') {
      return { reason: err.code, error: err.message };
    }

    // `bad_input` never became an edit attempt; counting it would inflate attempts.
    throw err;
  }

  if (!isVfsError(err)) {
    return { reason: 'io', error: `${action} ${path} failed: ${renderThrownChain({ cause: err })}` };
  }

  const reason = editOutcomeReason(err.code);

  // Only addressing mistakes get where the path landed; other errors carry their own reason.
  const hint = err.code === 'ENOENT' || err.code === 'EISDIR' ? `: ${addressingHint(planes, path)}` : '';

  return { reason, error: `${err.message}${hint}` };
}

/**
 * Where one call's path lands, links and `..` walked as the operation walks them, resolved once before the call touches
 * the file: it reads, writes and indexes there, and its result names that file, so a link moved while the call waits
 * cannot turn its answer into another file's.
 */
interface Landing {
  readonly at: string;
  /** What the call hands the plane: `at`, or, on a plane with no namespace to walk (a bare store, as a birth runtime's), the path as named. */
  readonly path: string;
  /** The memory note the file is, keyed as a relative path from the call's start names it; null outside `memory/`. */
  readonly note: string | null;
  readonly reference: string;
}

export interface FileDeps {
  /** The tool's file plane; its `resolve`, where it has one, says where a path landed, so a result names that file. */
  readonly vfs: VFS & CheckpointFiles & Partial<Pick<VfsMountRouting, 'resolve'>>;
  readonly home: string;
  readonly ledger: TurnFileLedger;
  /** The turn-cumulative bulk budget; a read the file outran is recorded there. */
  readonly budget: TurnContextBudget;
  /** Long-term memory, so a write under `memory/` re-indexes it. */
  readonly memory?: Memory;
  /** Where paths land (`vfs/resolve.ts`), so results name files as `root://path`. */
  readonly planes: PathPlanes;
  /**
   * Whether a slate still builds, by the build its preview serves, so a write into one answers it. A check, not a
   * preview: the turn's answer still draws the slate. Cloudflare only: the CLI hosts no slates, so it leaves this
   * unset (`scripts/capability-parity.lock.json`).
   */
  readonly slateBuild?: (slate: string) => Promise<SlateCallResult>;
}

const SLATE_FILE = new RegExp(`^${SLATES_ROOT}/([^/]+)/`);

const BrokenSchema = v.object({ broken: v.string() });

/**
 * Whether the slate a written file belongs to still builds; nothing for a file outside one, or where no slate host
 * answers. The slate is the one the path the write landed on names.
 */
async function slateBuild(deps: FileDeps, path: string): Promise<{ readonly build?: v.InferOutput<typeof SlateBuildNoteSchema> }> {
  const slate = SLATE_FILE.exec(normalizePath(resolvePath(path, deps.planes).absolute))?.[1];

  if (slate === undefined || deps.slateBuild === undefined) return {};
  const built = await deps.slateBuild(slate);

  // Only its own files can be at fault; a preview this deployment cannot serve says nothing about them.
  if (!built.ok) return built.reason === 'bad_input' ? { build: { slate, builds: false, error: built.error } } : {};
  const broken = v.safeParse(BrokenSchema, built.value);

  return { build: broken.success ? { slate, builds: false, error: broken.output.broken } : { slate, builds: true } };
}

/** Read per call: a turn's ledger and budget are its own. */
export function serveFile(current: () => FileDeps): Readonly<Record<keyof typeof FILE, Served>> {
  const run = <A>(body: (files: ReturnType<typeof fileOps>) => Promise<A>) => body(fileOps(current()));

  return {
    read: serve(FILE.read, async ({ path, offset, limit }) => await run((files) => files.read(path, { offset, limit }))),
    text: serve(FILE.text, async ({ path }) => await run((files) => files.text(path))),
    edit: serve(FILE.edit, async ({ path, edits }) => await run((files) => files.edit(path, edits))),
    write: serve(FILE.write, async ({ path, content }) => await run((files) => files.write(path, content))),
    list: serve(FILE.list, async ({ path, offset }) => await run((files) => files.list(path, offset ?? 0))),
    stat: serve(FILE.stat, async ({ path }) => await run((files) => files.stat(path))),
    search: serve(FILE.search, async ({ path, query }) => await run((files) => files.search(path, query))),
  };
}

const ReadCallSchema = v.object({ op: v.literal('read') });

/**
 * The native `file` tool. A read shows its own window, up to `FILE_READ_MAX_CHARS`, so only its larger cap applies to
 * it; any other result the turn's budget cannot hold is spilled, as any tool result is.
 */
export function createFileTool(files: FileDeps): Tool {
  const served = serveFile(() => files);
  // A whole file is a program's to hold; the native tool reads a window of it.
  const tool = nativeTool(BUILTIN_TOOL_DESCRIPTIONS.file, Object.values(served).filter((member) => member !== served.text));
  const clamp = { files: { vfs: files.vfs, home: files.home }, budget: files.budget, producer: 'file_read', images: true } as const;
  const reads = withClampedToolResult(tool, { ...clamp, maxChars: FILE_READ_MAX_CHARS });
  const others = withClampedToolResult(tool, clamp);

  return { ...others, execute: async (input, options) => await (v.is(ReadCallSchema, input) ? reads : others).execute?.(input, options) };
}

/** `file.*` for programs and slates, on the native tool's ledger. */
export function createFileCodemodeProvider(current: () => FileDeps): CodemodeProvider {
  return codemodeNamespace('file', 'Your workspace files, read and edited as the file tool does: an edit needs a read first.', Object.values(serveFile(current)));
}

function fileOps(deps: FileDeps) {
  const { vfs, ledger, budget } = deps;

  /** A Plan-safe inspection: the VFS answer, bounded like a read. */
  const inspect = async <A>(action: 'list' | 'stat' | 'search', path: string, read: () => Promise<A | null>): Promise<A> => {
    let output: A | null;

    try { output = await read(); }
    catch (cause) {
      const refused = vfsFailure(deps.planes, { error: cause }, action, path);

      return failure(refused.reason, refused.error);
    }

    return output ?? failure('missing', 'No path at ' + path);
  };

  const searchLines = (content: string, query: string): { line: number; text: string }[] =>
    content.split('\n').flatMap((text, index) => text.includes(query) ? [{ line: index + 1, text }] : []);

  /** The one write path: conditioned on what was read (`vfs/conditional-write.ts`). `observe` runs as soon as the
   *  bytes land, so a later failure cannot leave the ledger denying content already on disk. */
  const persist = async (
    target: Landing, content: string, observe: (revision?: VfsRevision) => void, observed: ObservedFile,
  ): Promise<{ readonly report: VfsWriteReport | null; readonly checked: WriteGuarantee }> => {
    const dir = vfsDirname(target.path);

    if (dir) await ensureDir(vfs, dir);
    const written = await writeConditionally(vfs, target.path, new TextEncoder().encode(content), observed);

    observe('revision' in written.now ? written.now.revision : undefined);

    if (deps.memory && target.note !== null) await deps.memory.index(target.note);

    return { report: written.report, checked: written.guarantee };
  };

  /** The file as it is now, with the revision that names it where the plane versions its files; absent, none. */
  const readObserved = async (path: string, revision?: VfsRevision): Promise<{ readonly text: string | null; readonly observed: ObservedFile }> => {
    // The revision read before the bytes: a write between the two is refused by the plane's own check, not lost.
    const at = revision ?? (await vfs.stat(path))?.revision;
    const historical = revision === undefined ? undefined : vfs.readFileAtRevision?.bind(vfs);

    const load = async () => (historical !== undefined && revision !== undefined ? await historical(path, revision) : await vfs.readFile(path));
    // A file the agent read and is gone now is a change, not an absence to create into.
    const bytes = revision === undefined ? await tolerateAsync(load, 'enoent') : await load();

    if (bytes === undefined) return { text: null, observed: { kind: 'absent' } };

    const read: ObservedFile = at === undefined ? { kind: 'read', bytes } : { kind: 'read', bytes, revision: at };

    return { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), observed: read };
  };

  const undo = (report: VfsWriteReport | null) => (report === null ? {} : { undo: uncheckpointedSentence(report.uncheckpointed, 'this write') });

  /** The read-before-write gate, shared by edit and overwriting write. `partial` classifies
   *  as `unread`; it is only reachable on `whole`. */
  const gate = (path: string, current: string, action: 'edit' | 'overwrite'): GateVerdict => {
    const need: FileSeenNeed = action === 'edit' ? 'part' : 'whole';
    const verdict = ledger.seenState(path, current, need);

    switch (verdict.state) {
      case 'seen':
        return { refusal: null, reason: null };
      case 'partial':
        return { reason: 'unread', refusal:
          `You have read only lines 1-${verdict.coveredTo} of ${verdict.total} in ${path}, so replacing it ` +
          `would discard ${verdict.total - verdict.coveredTo} lines you have not seen. ` +
          `Change part of it with op=edit, or read the rest first (op=read path=${path} offset=${verdict.coveredTo + 1}). ` +
          `If line ${verdict.coveredTo + 1} runs past ${String(FILE_READ_LINE_CHARS)} characters, a read cuts it and never counts it as seen: ` +
          'read the whole file with file.text inside eval to cover it.' };
      case 'stale':
        return { reason: 'stale', refusal:
          `${path} changed since you read it. Read it again (op=read path=${path}) before you ` +
          (action === 'edit' ? 'edit it: the text you are matching may have moved.' : 'replace it, so you know what you are discarding.') };
      case 'never':
        return { reason: 'unread', refusal:
          `${path} has not been read here yet, so ${action === 'edit' ? 'editing' : 'overwriting'} it would be blind. ` +
          `Call op=read path=${path} first` +
          (action === 'edit' ? ', then copy old_text out of what it returns.' : '.') };
    }
  };

  /** Where a call's path lands, walked once before the call touches the file (`creating` for a write that makes its parents). */
  const landing = async (path: string, creating: boolean): Promise<Landing> => {
    if (vfs.resolve === undefined) {
      const at = resolvePath(path, deps.planes).absolute;

      return { at, path, note: memoryIndexPath(path), reference: formatPath(at, deps.planes) };
    }

    const at = await vfs.resolve(path, { creating });
    const { cwd } = deps.planes;

    return { at, path: at, note: at.startsWith(`${cwd}/`) ? memoryIndexPath(at.slice(cwd.length + 1)) : null, reference: formatPath(at, deps.planes) };
  };

  /** A raster image is shown to the model, as a screenshot is: its text would be noise. Null for anything else. */
  const imageRead = async (path: string): Promise<ImageCarrier | null> => {
    const target = await landing(path, false);
    const bytes = await vfs.readFile(target.path);
    const image = rasterImage(bytes);

    if (image === null) return null;

    if (bytes.byteLength > IMAGE_READ_MAX_BYTES) {
      return failure('bad_input', `${path} is a ${image.width}x${image.height} image of ${bytes.byteLength} bytes, above the `
        + `${IMAGE_READ_MAX_BYTES} a model is shown; scale it down with the shell first.`);
    }

    const output = `${target.reference}: ${image.mediaType} ${image.width}x${image.height}, ${bytes.byteLength} bytes`;

    return imageCarrier(output, [{ mediaType: image.mediaType, data: bytesToBase64(bytes) }]);
  };

  /** A text read reads every byte (the ledger keys on the whole-content fingerprint) but retains only this window and the running hash. */
  const read = async (path: string, args: { readonly offset?: number | undefined; readonly limit?: number | undefined }): Promise<string | ImageCarrier> => {
    const maxChars = FILE_READ_MAX_CHARS;
    let scanned: ScannedFile;

    try {
      const shown = RASTER_PATH.test(path) ? await imageRead(path) : null;

      if (shown !== null) return shown;
      scanned = await scanFileWindow(vfs, path, { offset: args.offset, limit: args.limit ?? FILE_READ_LINES, maxChars });
    } catch (err) {
      const vfsFail = vfsFailure(deps.planes, { error: err }, 'read', path);

      return failure(vfsFail.reason, vfsFail.error);
    }

    const slice = formatFileSlice(scanned.window, { path, limit: args.limit, maxChars });

    ledger.observeRange(path, {
      fingerprint: scanned.fingerprint, first: slice.first, last: slice.uncutTo, total: slice.total, revision: scanned.revision,
    });

    if (slice.omitted > 0) {
      // Not spilled: the file is addressable at its path and the marker names the continuing offset.
      budget.recordSpill({ producer: 'file_read', omitted: slice.omitted, referenced: true });
    }

    return slice.output;
  };

  /** The whole file for a program, which holds the value: a later write or edit through either surface is not blind. */
  const text = async (path: string): Promise<string> => {
    let whole: string;

    try { whole = await readText(vfs, path); }
    catch (err) {
      const refused = vfsFailure(deps.planes, { error: err }, 'read', path);

      return failure(refused.reason, refused.error);
    }

    ledger.observeWhole(path, whole);

    return whole;
  };

  return {
    read,
    text,
    list: (path: string, offset: number) => inspect('list', path, async () => boundListing(path, (await vfs.readdir(path)).map(({ name }) => name), offset)),
    stat: (path: string) => inspect('stat', path, async () => {
      const stat = await vfs.stat(path);

      return stat === null ? null : { path, size: stat.size, mtimeMs: stat.mtimeMs, isDir: stat.type === 'directory' };
    }),
    search: (path: string, query: string) => inspect('search', path, async () => {
      const head = await readFileHead(vfs, path, FILE_SEARCH_MAX_BYTES);
      const matches = searchLines(head.text, query);

      return head.total !== null && head.total > head.bytes ? { path, matches, truncated: { shown: head.bytes, total: head.total } } : { path, matches };
    }),
    write: async (path: string, content: string) => {
      requireBuild('file.write');
      let target: Landing;
      let existing: string | null;
      let observed: ObservedFile;

      try {
        target = await landing(path, true);
        ({ text: existing, observed } = await readObserved(target.path));
      } catch (err) {
        const vfsFail = vfsFailure(deps.planes, { error: err }, 'write', path);

        return failure(vfsFail.reason, vfsFail.error);
      }

      if (existing !== null) {
        const { refusal, reason } = gate(path, existing, 'overwrite');

        if (refusal && reason) return failure(reason, refusal);
      }

      let landed: { readonly report: VfsWriteReport | null; readonly checked: WriteGuarantee };

      try {
        landed = await persist(target, content, (revision) => ledger.observeWhole(path, content, revision), observed);
      } catch (err) {
        const vfsFail = vfsFailure(deps.planes, { error: err }, 'write', path);

        return failure(vfsFail.reason, vfsFail.error);
      }

      return {
        path, reference: target.reference, bytes: content.length, action: existing === null ? 'created' as const : 'replaced' as const,
        checked: landed.checked, ...undo(landed.report),
        ...await slateBuild(deps, target.at),
      };
    },
    edit: async (path: string, raw: readonly { readonly old_text: string; readonly new_text: string }[]) => {
      requireBuild('file.edit');
      const edits: FileEdit[] = raw.map((edit) => ({ oldText: edit.old_text, newText: edit.new_text }));

      let target: Landing;
      let current: string;
      let observed: ObservedFile;

      try {
        target = await landing(path, false);
        // The revision the agent read, where the plane keeps it: the edit applies to what was read.
        let held;

        try {
          held = await readObserved(target.path, ledger.readRevision(path));
        } catch (cause) {
          if (!isVfsError(cause) || cause.code !== 'ENOTSUP') throw cause;
          held = await readObserved(target.path);
        }

        if (held.text === null) throw new VfsError('ENOENT', 'no such file, open', path);
        ({ text: current, observed } = { text: held.text, observed: held.observed });
      } catch (err) {
        const vfsFail = vfsFailure(deps.planes, { error: err }, 'edit', path);
        ledger.recordEdit(path, vfsFail.reason);

        return failure(vfsFail.reason, vfsFail.error);
      }

      const { refusal, reason } = gate(path, current, 'edit');

      if (refusal && reason) {
        ledger.recordEdit(path, reason);

        return failure(reason, refusal);
      }

      const outcome = applyFileEdits(current, edits, path);

      if (!outcome.ok) {
        ledger.recordEdit(path, outcome.reason);

        return failure(outcome.reason, outcome.message);
      }

      let landed: { readonly report: VfsWriteReport | null; readonly checked: WriteGuarantee };

      try {
        landed = await persist(target, outcome.content, (writtenRevision) => ledger.observeEdited(path, current, outcome, writtenRevision), observed);
      } catch (err) {
        const vfsFail = vfsFailure(deps.planes, { error: err }, 'edit', path);
        ledger.recordEdit(path, vfsFail.reason);

        return failure(vfsFail.reason, vfsFail.error);
      }

      ledger.recordEdit(path, null);

      return {
        path, reference: target.reference,
        applied: outcome.applied.map((a) => ({ line: a.line, removedLines: a.removedLines, addedLines: a.addedLines })),
        checked: landed.checked, ...undo(landed.report),
        ...await slateBuild(deps, target.at),
      };
    },
  };
}
