/**
 * The file operations served over `rt.toolFiles`. A write or edit is refused until the agent has read what it would
 * replace, here or by the native tool: one ledger for both.
 */
import { type VFS, type VfsRevision, writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { isVfsError, type VfsErrorCode } from '@nimbus-sh/core/vfs/vfs-error.js';
import { vfsAddressingHint } from '@kinu.run/agent-utils/vfs';
import * as v from 'valibot';
import { formatPath, resolvePath, type PathPlanes } from '../vfs/resolve';
import type { CheckpointFiles, Memory, VfsWriteReport } from '../types/primitives';
import type { TurnContextBudget } from '../context-budget';
import { ensureDir, vfsDirname } from '../utils/vfs-helpers';
import { memoryIndexPath } from '../memory/note';
import { applyFileEdits, formatFileSlice, FILE_REFUSAL_REASONS, type FileEdit } from './file-edit';
import { FileRefusalError } from '../types/file-edits';
import { readFileHead, readFileText, scanFileWindow, type ScannedFile } from './file-scan';
import type { TurnFileLedger, FileEditOutcomeReason, FileSeenNeed } from '../vfs/file-ledger';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from './clamp';
import { KinuError, renderThrownChain } from '../obs/index';
import { requireBuild } from '../execution/work-mode';
import { uncheckpointedSentence } from '../execution/exec-result';
import { RESIDENT_TEXT_MAX_BYTES } from '../vfs/mounts';
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
import type { SlateCallResult, SlateOperation } from '../slates/rpc';

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

/** `truncated` is absent on a whole listing, so its presence is the fact. */
function boundListing(path: string, entries: readonly string[]): { path: string; entries: string[]; truncated?: { shown: number; total: number } } {
  const shown: string[] = [];
  let chars = 0;

  for (const entry of entries) {
    if (shown.length >= FILE_LIST_MAX_ENTRIES || chars + entry.length > FILE_LIST_MAX_CHARS) break;
    chars += entry.length;
    shown.push(entry);
  }

  return shown.length === entries.length
    ? { path, entries: shown }
    : { path, entries: shown, truncated: { shown: shown.length, total: entries.length } };
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

async function vfsFailure(vfs: VFS, input: { error: unknown }, action: string, path: string): Promise<{
  reason: FileEditOutcomeReason;
  error: string;
}> {
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

  // Only addressing mistakes get the roots hint; other errors carry their own reason.
  const hint = err.code === 'ENOENT' || err.code === 'EISDIR'
    ? `: ${await vfsAddressingHint(vfs, 'the `file` tool\'s path')}`
    : '';

  return { reason, error: `${err.message}${hint}` };
}

export interface FileDeps {
  readonly vfs: VFS & CheckpointFiles;
  readonly home: string;
  readonly ledger: TurnFileLedger;
  /** The turn-cumulative bulk budget; a read the file outran is recorded there. */
  readonly budget: TurnContextBudget;
  /** Long-term memory, so a write under `memory/` re-indexes it. */
  readonly memory?: Memory;
  /** Where paths land (`vfs/resolve.ts`), so results name files as `root://path`. */
  readonly planes: PathPlanes;
  /**
   * The workspace's slates, so a write into one answers whether it still builds, by the build its preview serves.
   * Cloudflare only: the CLI hosts no slates, so it leaves this unset (`scripts/capability-parity.lock.json`).
   */
  readonly slate?: (operation: SlateOperation) => Promise<SlateCallResult>;
}

const SLATE_FILE = new RegExp(`^${SLATES_ROOT}/([^/]+)/`);

const BrokenSchema = v.object({ broken: v.string() });

/** Whether the slate a written file belongs to still builds; nothing for a file outside one, or where no slate host answers. */
async function slateBuild(deps: FileDeps, path: string): Promise<{ readonly build?: v.InferOutput<typeof SlateBuildNoteSchema> }> {
  const slate = SLATE_FILE.exec(resolvePath(path, deps.planes).absolute)?.[1];

  if (slate === undefined || deps.slate === undefined) return {};
  const previewed = await deps.slate({ op: 'preview', id: slate });

  // Only its own files can be at fault; a preview this deployment cannot serve says nothing about them.
  if (!previewed.ok) return previewed.reason === 'bad_input' ? { build: { slate, builds: false, error: previewed.error } } : {};
  const broken = v.safeParse(BrokenSchema, previewed.value);

  return { build: broken.success ? { slate, builds: false, error: broken.output.broken } : { slate, builds: true } };
}

/** Read per call: a turn's ledger and budget are its own. */
export function serveFile(current: () => FileDeps): Readonly<Record<keyof typeof FILE, Served>> {
  const run = <A>(body: (files: ReturnType<typeof fileOps>) => Promise<A>) => body(fileOps(current()));

  return {
    read: serve(FILE.read, async ({ path, offset, limit }) => await run((files) => files.read(path, { offset, limit }))),
    edit: serve(FILE.edit, async ({ path, edits }) => await run((files) => files.edit(path, edits))),
    write: serve(FILE.write, async ({ path, content }) => await run((files) => files.write(path, content))),
    list: serve(FILE.list, async ({ path }) => await run((files) => files.list(path))),
    stat: serve(FILE.stat, async ({ path }) => await run((files) => files.stat(path))),
    search: serve(FILE.search, async ({ path, query }) => await run((files) => files.search(path, query))),
  };
}

/** The native `file` tool; a read the turn's budget cannot hold is spilled, as any tool result is. */
export function createFileTool(files: FileDeps): Tool {
  return withClampedToolResult(nativeTool(BUILTIN_TOOL_DESCRIPTIONS.file, Object.values(serveFile(() => files))),
    { files: { vfs: files.vfs, home: files.home }, budget: files.budget, producer: 'file_read', images: true });
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
      const refused = await vfsFailure(vfs, { error: cause }, action, path);

      return failure(refused.reason, refused.error);
    }

    return output ?? failure('missing', 'No path at ' + path);
  };

  const searchLines = (content: string, query: string): { line: number; text: string }[] =>
    content.split('\n').flatMap((text, index) => text.includes(query) ? [{ line: index + 1, text }] : []);

  /** The one write path. `observe` runs as soon as the bytes land, so a later failure
   *  cannot leave the ledger denying content already on disk. */
  const persist = async (
    path: string, content: string, observe: (revision?: VfsRevision) => void, expected?: VfsRevision,
  ): Promise<VfsWriteReport | null> => {
    const dir = vfsDirname(path);
    let report: VfsWriteReport | null = null;

    if (dir) await ensureDir(vfs, dir);

    if (expected === undefined) {
      if (vfs.writeFileWithReport) report = await vfs.writeFileWithReport(path, new TextEncoder().encode(content));
      else await writeText(vfs, path, content);
      observe();
    } else {
      if (!vfs.writeFileIfRevision) throw new KinuError('unsupported', 'versioned edits require revision-checked writes');
      const result = await vfs.writeFileIfRevision(path, new TextEncoder().encode(content), expected);

      if (!result.ok) throw new FileRefusalError('stale', `${path} changed since the observed revision`);
      observe(result.revision);
    }

    const indexed = memoryIndexPath(path);

    if (deps.memory && indexed) await deps.memory.index(indexed);

    return report;
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
          `Change part of it with op=edit, or read the rest first (op=read path=${path} offset=${verdict.coveredTo + 1}).` };
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

  /** How a result names its file: the reference the live table gives it. */
  const referenceOf = (path: string): string => formatPath(resolvePath(path, deps.planes).absolute, deps.planes);

  /** A raster image is shown to the model, as a screenshot is: its text would be noise. Null for anything else. */
  const imageRead = async (path: string): Promise<ImageCarrier | null> => {
    const bytes = await vfs.readFile(path);
    const image = rasterImage(bytes);

    if (image === null) return null;

    if (bytes.byteLength > IMAGE_READ_MAX_BYTES) {
      return failure('bad_input', `${path} is a ${image.width}x${image.height} image of ${bytes.byteLength} bytes, above the `
        + `${IMAGE_READ_MAX_BYTES} a model is shown; scale it down with the shell first.`);
    }

    const output = `${referenceOf(path)}: ${image.mediaType} ${image.width}x${image.height}, ${bytes.byteLength} bytes`;

    return imageCarrier(output, [{ mediaType: image.mediaType, data: bytesToBase64(bytes) }]);
  };

  /** A text read reads every byte (the ledger keys on the whole-content fingerprint) but retains only this window and the running hash. */
  const read = async (path: string, args: { readonly offset?: number | undefined; readonly limit?: number | undefined }): Promise<string | ImageCarrier> => {
    const maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS;
    let scanned: ScannedFile;

    try {
      const shown = RASTER_PATH.test(path) ? await imageRead(path) : null;

      if (shown !== null) return shown;
      scanned = await scanFileWindow(vfs, path, { offset: args.offset, limit: args.limit, maxChars });
    } catch (err) {
      const vfsFail = await vfsFailure(vfs, { error: err }, 'read', path);

      return failure(vfsFail.reason, vfsFail.error);
    }

    const slice = formatFileSlice(scanned.window, { path, limit: args.limit, maxChars });

    ledger.observeRange(path, {
      fingerprint: scanned.fingerprint, first: slice.first, last: slice.last, total: slice.total, revision: scanned.revision,
    });

    if (slice.omitted > 0) {
      // Not spilled: the file is addressable at its path and the marker names the continuing offset.
      budget.recordSpill({ producer: 'file_read', omitted: slice.omitted, referenced: true });
    }

    return slice.output;
  };

  return {
    read,
    list: (path: string) => inspect('list', path, async () => boundListing(path, (await vfs.readdir(path)).map(({ name }) => name))),
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
      let existing: string | null = null;

      try {
        existing = await readFileText(vfs, path);
      } catch (err) {
        if (!isVfsError(err) || err.code !== 'ENOENT') {
          const vfsFail = await vfsFailure(vfs, { error: err }, 'write', path);

          return failure(vfsFail.reason, vfsFail.error);
        }
      }

      if (existing !== null) {
        const { refusal, reason } = gate(path, existing, 'overwrite');

        if (refusal && reason) return failure(reason, refusal);
      }

      let report: VfsWriteReport | null;

      try {
        report = await persist(path, content, () => ledger.observeWhole(path, content));
      } catch (err) {
        const vfsFail = await vfsFailure(vfs, { error: err }, 'write', path);

        return failure(vfsFail.reason, vfsFail.error);
      }

      return {
        path, reference: referenceOf(path), bytes: content.length, action: existing === null ? 'created' as const : 'replaced' as const, ...undo(report),
        ...await slateBuild(deps, path),
      };
    },
    edit: async (path: string, raw: readonly { readonly old_text: string; readonly new_text: string }[]) => {
      requireBuild('file.edit');
      const edits: FileEdit[] = raw.map((edit) => ({ oldText: edit.old_text, newText: edit.new_text }));

      let current: string;
      let revision = ledger.readRevision(path);

      try {
        try {
          current = await readFileText(vfs, path, revision);
        } catch (cause) {
          if (!isVfsError(cause) || cause.code !== 'ENOTSUP') throw cause;
          revision = undefined;
          current = await readFileText(vfs, path);
        }
      } catch (err) {
        const vfsFail = await vfsFailure(vfs, { error: err }, 'edit', path);
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

      let report: VfsWriteReport | null;

      try {
        // Coverage carries across the edit: only the named span changed.
        report = await persist(path, outcome.content, (writtenRevision) => ledger.observeEdited(path, current, outcome.content, writtenRevision), revision);
      } catch (err) {
        const vfsFail = await vfsFailure(vfs, { error: err }, 'edit', path);
        ledger.recordEdit(path, vfsFail.reason);

        return failure(vfsFail.reason, vfsFail.error);
      }

      ledger.recordEdit(path, null);

      return {
        path, reference: referenceOf(path),
        applied: outcome.applied.map((a) => ({ line: a.line, removedLines: a.removedLines, addedLines: a.addedLines })),
        ...undo(report),
        ...await slateBuild(deps, path),
      };
    },
  };
}
