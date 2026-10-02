import { type VFS, type VfsRevision, writeText } from '@nimbus-sh/core/vfs/vfs.js';
/**
 * `file` — the built-in file plane: read, edit, write, all through `rt.toolFiles`.
 * No second filesystem path; another environment is reached through its own namespace.
 */

import { formatReference, type ReferenceRoot } from '../vfs/references';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import * as v from 'valibot';
import { z } from 'zod';
import { oneOf } from './tool-schema';
import type { CheckpointFiles, Memory, VfsWriteReport } from '../types/primitives';
import type { TurnContextBudget } from '../context-budget';
import { vfsAddressingHint } from '@kinu.run/agent-utils/vfs';
import { isVfsError, type VfsErrorCode } from '@nimbus-sh/core/vfs/vfs-error.js';
import { ensureDir, vfsDirname } from '../utils/vfs-helpers';
import { memoryIndexPath } from '../memory/note';
import { BUILTIN_TOOL_DESCRIPTIONS, FILE_TOOL_ACTIONS } from './registry';
import { applyFileEdits, formatFileSlice, FILE_REFUSAL_REASONS, type FileEdit } from './file-edit';
import { FileRefusalError } from '../types/file-edits';
import { readFileHead, readFileText, scanFileWindow, type ScannedFile } from './file-scan';
import { TurnFileLedger, type FileEditOutcomeReason, type FileSeenNeed } from '../vfs/file-ledger';
import { DEFAULT_TOOL_RESULT_MAX_CHARS, clampSerializedToolResult } from './clamp';
import type { JsonObject, JsonValue } from '../utils/json';
import { Effect, Result } from 'effect';
import { KinuError, renderThrownChain, settle } from '../obs/index';
import { permitInPlan, requireBuild } from '../execution/work-mode';
import { uncheckpointedSentence } from '../execution/exec-result';
import { RESIDENT_TEXT_MAX_BYTES } from '../vfs/mounts';

/** Most names one `list` returns; matches `tools/db-codemode.ts` SELECT_LIMIT_MAX. */
const FILE_LIST_MAX_ENTRIES = 1_000;

/** Most characters of names one `list` returns, for a directory of few enormous entries. */
const FILE_LIST_MAX_CHARS = RESIDENT_TEXT_MAX_BYTES;

/** Most bytes one `search` reads of the scanned file (same budget as `vfs/mounts.ts`). */
const FILE_SEARCH_MAX_BYTES = RESIDENT_TEXT_MAX_BYTES;

/** `truncated` is absent on a whole listing, so its presence is the fact. */
function boundListing(path: string, entries: readonly string[]): JsonValue {
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

export interface FileToolDeps {
  vfs: VFS & CheckpointFiles;
  ledger: TurnFileLedger;
  /** The turn-cumulative bulk budget; a file read counts as bulk. */
  budget: TurnContextBudget;
  /** Long-term memory, so a write under `memory/` re-indexes FTS like `workspace.writeFile`. */
  memory?: Memory;
  /** Live reference roots (`vfs/references.ts`), so results name files as `root://path`. */
  roots?: () => readonly ReferenceRoot[];
}

/** One replacement; a missing new_text must not default to deleting the match. */
export const FileEditInputSchema = z.object({
  old_text: z.string({ error: 'old_text is the text to find, copied exactly from the file' })
    .describe('Text copied exactly from the file, with enough context to occur once.'),
  new_text: z.string({ error: 'new_text replaces old_text, and "" deletes it' }).describe('The replacement; empty deletes.'),
});

/** Input of the native tool and of `workspace.*` in eval. */
const FileToolInputSchema = z.object({
  action: oneOf(FILE_TOOL_ACTIONS),
  path: z.string().trim().min(1)
    .describe('Relative paths resolve at the workspace root.'),
  offset: z.number().describe('For read: the first line, 1-indexed (default 1).').optional(),
  limit: z.number().describe('For read: lines to return (default: as many as fit).').optional(),
  content: z.string().describe('For write: the whole new content.').optional(),
  query: z.string().describe('For search: literal text; returns the matching lines with their numbers.').optional(),
  edits: z.array(FileEditInputSchema)
    .describe('For edit: replacements matched against the file as last read, applied together or not at all.').optional(),
});

export type FileToolInput = z.infer<typeof FileToolInputSchema>;

/** The read-before-write gate's refusal and reason, or both null when the operation may proceed. */
interface GateVerdict {
  readonly refusal: string | null;
  readonly reason: FileEditOutcomeReason | null;
}

const QuerySchema = z.string().min(1);

/** Why a `file` call failed: the ledger's reasons plus malformed arguments, which never
 *  became an edit attempt and must not inflate `attempts`. */
export type FileToolFailureReason = FileEditOutcomeReason | 'bad_input';

/** Fail at the operation that made the decision; callers choose the native or namespace boundary. */
function failure(reason: FileToolFailureReason, error: string): Effect.Effect<never, KinuError> {
  return Effect.fail(v.is(v.picklist(FILE_REFUSAL_REASONS), reason) ? new FileRefusalError(reason, error) : new KinuError(reason, error));
}

interface Failed { readonly cause: unknown }

const tried = <A>(run: () => A | PromiseLike<A>): Effect.Effect<A, Failed> => Effect.tryPromise({ try: async () => run(), catch: (cause) => ({ cause }) });

/** Which refusal a VFS errno is: absent path, permission wall, or filesystem failure. */
function editOutcomeReason(code: VfsErrorCode): FileEditOutcomeReason {
  if (code === 'ENOENT') return 'missing';

  if (code === 'EACCES' || code === 'EPERM') return 'denied';

  return 'io';
}

function vfsFailure(vfs: VFS, input: { error: unknown }, action: string, path: string): Effect.Effect<{
  reason: FileEditOutcomeReason;
  error: string;
}, KinuError> {
  const err = input.error;

  if (err instanceof FileRefusalError) return Effect.succeed({ reason: err.verdict, error: err.message });

  if (err instanceof KinuError) {
    if (err.code === 'denied' || err.code === 'missing' || err.code === 'io') {
      return Effect.succeed({ reason: err.code, error: err.message });
    }

    // `bad_input` never became an edit attempt; counting it would inflate attempts.
    return Effect.fail(err);
  }

  if (!isVfsError(err)) {
    return Effect.succeed({ reason: 'io', error: `${action} ${path} failed: ${renderThrownChain({ cause: err })}` });
  }

  const reason = editOutcomeReason(err.code);

  // Only addressing mistakes get the roots hint; other errors carry their own reason.
  if (err.code !== 'ENOENT' && err.code !== 'EISDIR') return Effect.succeed({ reason, error: err.message });

  return Effect.map(Effect.promise(() => vfsAddressingHint(vfs, 'the `file` tool\'s path')), (hint) => ({ reason, error: `${err.message}: ${hint}` }));
}

function vfsRefused(vfs: VFS, failed: Failed, action: string, path: string): Effect.Effect<never, KinuError> {
  return Effect.flatMap(vfsFailure(vfs, { error: failed.cause }, action, path), (refused) => failure(refused.reason, refused.error));
}

/** Shared by the native `file` tool and codemode's `workspace.writeFile`/`editFile`: one ledger, one refusal. */
export function createFileDispatcher(deps: FileToolDeps): (input: FileToolInput) => Promise<JsonValue> {
  const { vfs, ledger, budget } = deps;

  /** A Plan-safe inspection: the VFS answer, bounded like a read. */
  const inspect = (action: 'list' | 'stat' | 'search', path: string, read: () => Promise<JsonValue | null>): Effect.Effect<JsonValue, KinuError> => Effect.gen(function* () {
    const output = yield* Effect.catch(tried(read), (failed) => vfsRefused(vfs, failed, action, path));

    if (output === null) return yield* failure('missing', 'No path at ' + path);
    const bounded = yield* Effect.promise(() => clampSerializedToolResult({ output }, { vfs, budget, producer: 'file_read' }));

    return bounded ?? (yield* failure('io', 'File inspection produced no serializable result'));
  });

  const searchLines = (content: string, query: string): { line: number; text: string }[] =>
    content.split('\n').flatMap((text, index) => text.includes(query) ? [{ line: index + 1, text }] : []);

  /** The one write path. `observe` runs as soon as the bytes land, so a later failure
   *  cannot leave the ledger denying content already on disk. */
  const persist = (
    path: string, content: string, observe: (revision?: VfsRevision) => void, expected?: VfsRevision,
  ): Effect.Effect<VfsWriteReport | null, Failed> => Effect.gen(function* () {
    const dir = vfsDirname(path);
    let report: VfsWriteReport | null = null;

    if (dir) yield* tried(() => ensureDir(vfs, dir));

    if (expected === undefined) {
      const reporting = vfs.writeFileWithReport?.bind(vfs);

      if (reporting) report = yield* tried(() => reporting(path, new TextEncoder().encode(content)));
      else yield* tried(() => writeText(vfs, path, content));
      yield* Effect.try({ try: () => observe(), catch: (cause) => ({ cause }) });
    } else {
      const checked = vfs.writeFileIfRevision?.bind(vfs);

      if (!checked) return yield* Effect.fail({ cause: new KinuError('unsupported', 'versioned edits require revision-checked writes') });
      const result = yield* tried(() => checked(path, new TextEncoder().encode(content), expected));

      if (!result.ok) return yield* Effect.fail({ cause: new FileRefusalError('stale', `${path} changed since the observed revision`) });
      yield* Effect.try({ try: () => observe(result.revision), catch: (cause) => ({ cause }) });
    }

    const indexed = memoryIndexPath(path);
    const memory = deps.memory;

    if (memory && indexed) yield* tried(() => memory.index(indexed));

    return report;
  });

  const answered = (written: JsonObject, report: VfsWriteReport | null): JsonObject => {
    if (report) written.undo = uncheckpointedSentence(report.uncheckpointed, 'this write');

    return written;
  };

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
          `Change part of it with action=edit, or read the rest first (action=read path=${path} offset=${verdict.coveredTo + 1}).` };
      case 'stale':
        return { reason: 'stale', refusal:
          `${path} changed since you read it. Read it again (action=read path=${path}) before you ` +
          (action === 'edit' ? 'edit it: the text you are matching may have moved.' : 'replace it, so you know what you are discarding.') };
      case 'never':
        return { reason: 'unread', refusal:
          `${path} has not been read here yet, so ${action === 'edit' ? 'editing' : 'overwriting'} it would be blind. ` +
          `Call action=read path=${path} first` +
          (action === 'edit' ? ', then copy old_text out of what it returns.' : '.') };
    }
  };

  /** How a result names its file: the reference the live table gives it. */
  const referenceOf = (path: string): string => formatReference(path, deps.roots?.() ?? []);

  return (args: FileToolInput): Promise<JsonValue> => settle(Effect.gen(function* () {
    const { path } = args;

    if (args.action === 'write' || args.action === 'edit') requireBuild('file.' + args.action);

    switch (args.action) {
      case 'list':
        return yield* inspect('list', path, async () => boundListing(path, (await vfs.readdir(path)).map(({ name }) => name)));
      case 'stat':
        return yield* inspect('stat', path, async () => {
          const stat = await vfs.stat(path);

          return stat === null ? null : { path, size: stat.size, mtimeMs: stat.mtimeMs, isDir: (stat.type === 'directory') };
        });
      case 'search': {
        const query = QuerySchema.safeParse(args.query);

        if (!query.success) return yield* failure('bad_input', 'file search requires a non-empty literal query');

        return yield* inspect('search', path, async (): Promise<JsonValue> => {
          const head = await readFileHead(vfs, path, FILE_SEARCH_MAX_BYTES);
          const matches = searchLines(head.text, query.data);

          return head.total !== null && head.total > head.bytes
            ? { path, matches, truncated: { shown: head.bytes, total: head.total } }
            : { path, matches };
        });
      }

      case 'read': {
        const maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS;

        // Reads every byte (the ledger keys on the whole-content fingerprint) but retains
        // only this window and the running hash.
        const scanned: ScannedFile = yield* Effect.catch(
          tried(() => scanFileWindow(vfs, path, { offset: args.offset, limit: args.limit, maxChars })),
          (failed) => vfsRefused(vfs, failed, 'read', path),
        );

        const slice = formatFileSlice(scanned.window, { path, limit: args.limit, maxChars });

        ledger.observeRange(path, {
          fingerprint: scanned.fingerprint, first: slice.first, last: slice.last, total: slice.total, revision: scanned.revision,
        });
        budget.admit(slice.output.length);

        if (slice.omitted > 0) {
          // Not spilled: the file is addressable at its path and the marker names the continuing offset.
          budget.recordSpill({ producer: 'file_read', omitted: slice.omitted, referenced: true });
        }

        return slice.output;
      }

      case 'write': {
        if (args.content === undefined) return yield* failure('bad_input', 'file action=write requires `content`.');

        const existing = yield* Effect.catch(tried(() => readFileText(vfs, path)), (failed) => (isVfsError(failed.cause) && failed.cause.code === 'ENOENT'
          ? Effect.succeed(null)
          : vfsRefused(vfs, failed, 'write', path)));

        if (existing !== null) {
          const { refusal, reason } = gate(path, existing, 'overwrite');

          if (refusal && reason) return yield* failure(reason, refusal);
        }

        const content = args.content;
        const report = yield* Effect.catch(persist(path, content, () => ledger.observeWhole(path, content)), (failed) => vfsRefused(vfs, failed, 'write', path));

        return answered({
          ok: true, path, reference: referenceOf(path), bytes: args.content.length, action: existing === null ? 'created' : 'replaced',
        }, report);
      }

      case 'edit': {
        const raw = args.edits ?? [];

        if (raw.length === 0) {
          return yield* failure('bad_input', 'file action=edit requires `edits`: [{ old_text, new_text }].');
        }

        const edits: FileEdit[] = raw.map((edit) => ({ oldText: edit.old_text, newText: edit.new_text }));
        let revision = ledger.readRevision(path);

        const refusedEdit = (failed: Failed): Effect.Effect<never, KinuError> => Effect.flatMap(
          vfsFailure(vfs, { error: failed.cause }, 'edit', path),
          (vfsFail) => Effect.andThen(Effect.sync(() => ledger.recordEdit(path, vfsFail.reason)), failure(vfsFail.reason, vfsFail.error)),
        );

        const readAtRevision = Effect.catch(tried(() => readFileText(vfs, path, revision)), (failed) => {
          if (!isVfsError(failed.cause) || failed.cause.code !== 'ENOTSUP') return Effect.fail(failed);
          revision = undefined;

          return tried(() => readFileText(vfs, path));
        });

        const current = yield* Effect.catch(readAtRevision, refusedEdit);
        const { refusal, reason } = gate(path, current, 'edit');

        if (refusal && reason) {
          ledger.recordEdit(path, reason);

          return yield* failure(reason, refusal);
        }

        const outcome = applyFileEdits(current, edits, path);

        if (Result.isFailure(outcome)) {
          ledger.recordEdit(path, outcome.failure.reason);

          return yield* failure(outcome.failure.reason, outcome.failure.message);
        }

        // Coverage carries across the edit: only the named span changed.
        const report = yield* Effect.catch(
          persist(path, outcome.success.content, writtenRevision => ledger.observeEdited(path, current, outcome.success.content, writtenRevision), revision),
          refusedEdit,
        );

        ledger.recordEdit(path, null);

        return answered({
          ok: true,
          path,
          reference: referenceOf(path),
          applied: outcome.success.applied.map((a) => ({ line: a.line, removed_lines: a.removedLines, added_lines: a.addedLines })),
        }, report);
      }
    }
  }));
}

export function createFileTool(deps: FileToolDeps): ToolSet[string] {
  const run = createFileDispatcher(deps);

  return permitInPlan(tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.file,
    inputSchema: FileToolInputSchema,
    execute: async (args) => run(args),
  }));
}
