/**
 * `file` — the built-in file plane: read, edit, write, all through `rt.storage.vfs`.
 * No second filesystem path; another environment is reached through its own namespace.
 */

import { formatReference, type ReferenceRoot } from '../vfs/references';
import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import * as v from 'valibot';
import type { Memory, VFS, VfsRevision } from '../types/primitives';
import type { TurnContextBudget } from '../context-budget';
import { isVfsError, vfsAddressingHint, type VfsErrorCode } from '../vfs/errno';
import { ensureDir, vfsDirname } from '../utils/vfs-helpers';
import { memoryIndexPath } from '../memory/note';
import {
  BUILTIN_TOOL_DESCRIPTIONS, FILE_TOOL_ACTIONS, unknownActionError, type FileToolAction,
} from './registry';
import { applyFileEdits, formatFileSlice, FILE_REFUSAL_REASONS, FileRefusalError, type FileEdit } from './file-edit';
import { readFileHead, readFileText, scanFileWindow, type ScannedFile } from './file-scan';
import { TurnFileLedger, type FileEditOutcomeReason, type FileSeenNeed } from './file-ledger';
import { DEFAULT_TOOL_RESULT_MAX_CHARS, clampSerializedToolResult } from './clamp';
import type { JsonValue } from '../utils/json';
import { KinuError, renderThrownChain } from '../obs/index';
import { permitInPlan, requireBuild } from '../execution/work-mode';
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
  /** The agent's canonical workspace filesystem (rt.storage.vfs). */
  vfs: VFS;
  /** The turn's read/edit ledger. */
  ledger: TurnFileLedger;
  /** The turn-cumulative bulk budget; a file read counts as bulk. */
  budget: TurnContextBudget;
  /** Long-term memory, so a write under `memory/` re-indexes FTS like `workspace.writeFile`. */
  memory?: Memory;
  /** Live reference roots (`vfs/references.ts`), so results name files as `root://path`. */
  roots?: () => readonly ReferenceRoot[];
}

export interface FileToolInput {
  action: FileToolAction;
  path: string;
  offset?: number;
  limit?: number;
  content?: string;
  /** Literal content to find in a single file; no shell command is evaluated. */
  query?: string;
  edits?: Array<{ old_text?: string; new_text?: string }>;
}

/** The read-before-write gate's refusal and reason, or both null when the operation may proceed. */
interface GateVerdict {
  readonly refusal: string | null;
  readonly reason: FileEditOutcomeReason | null;
}

const QuerySchema = v.pipe(v.string(), v.minLength(1));

/** Why a `file` call failed: the ledger's reasons plus malformed arguments, which never
 *  became an edit attempt and must not inflate `attempts`. */
export type FileToolFailureReason = FileEditOutcomeReason | 'bad_input';

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
    ? ` — ${await vfsAddressingHint(vfs, 'the `file` tool\'s path')}`
    : '';

  return { reason, error: `${err.message}${hint}` };
}

/** The file plane's dispatch logic, shared by the native `file` tool and codemode's
 *  `workspace.writeFile`/`editFile` so both use one TurnFileLedger and refuse identically. */
export function createFileDispatcher(deps: FileToolDeps): (input: FileToolInput) => Promise<JsonValue> {
  const { vfs, ledger, budget } = deps;

  /** A Plan-safe inspection: the VFS answer, bounded like a read. */
  const inspect = async (action: 'list' | 'stat' | 'search', path: string, read: () => Promise<JsonValue | null>): Promise<JsonValue> => {
    let output: JsonValue | null;

    try { output = await read(); }
    catch (cause) {
      const refused = await vfsFailure(vfs, { error: cause }, action, path);

      return failure(refused.reason, refused.error);
    }

    if (output === null) return failure('missing', 'No path at ' + path);
    const bounded = await clampSerializedToolResult({ output }, { vfs, budget, producer: 'file_read' });

    return bounded ?? failure('io', 'File inspection produced no serializable result');
  };

  const searchLines = (content: string, query: string): { line: number; text: string }[] =>
    content.split('\n').flatMap((text, index) => text.includes(query) ? [{ line: index + 1, text }] : []);

  /** The one write path. `observe` runs as soon as the bytes land, so a later failure
   *  cannot leave the ledger denying content already on disk. */
  const persist = async (path: string, content: string, observe: (revision?: VfsRevision) => void, expected?: VfsRevision): Promise<void> => {
    const dir = vfsDirname(path);

    if (dir) await ensureDir(vfs, dir);

    if (expected === undefined) {
      await vfs.writeFile(path, content);
      observe();
    } else {
      if (!vfs.writeFileIfRevision) throw new KinuError('unsupported', 'versioned edits require revision-checked writes');
      const result = await vfs.writeFileIfRevision(path, new TextEncoder().encode(content), expected);

      if (!result.ok) throw new FileRefusalError('stale', `${path} changed since the observed revision`);
      observe(result.revision);
    }

    const indexed = memoryIndexPath(path);

    if (deps.memory && indexed) await deps.memory.index(indexed);
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
          (action === 'edit' ? 'edit it — the text you are matching may have moved.' : 'replace it, so you know what you are discarding.') };
      case 'never':
        return { reason: 'unread', refusal:
          `${path} has not been read here yet, so ${action === 'edit' ? 'editing' : 'overwriting'} it would be blind. ` +
          `Call action=read path=${path} first` +
          (action === 'edit' ? ', then copy old_text out of what it returns.' : '.') };
    }
  };

  const ActionSchema = v.picklist(FILE_TOOL_ACTIONS);
  const PathSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
  /** How a result names its file: the reference the live table gives it. */
  const referenceOf = (path: string): string => formatReference(path, deps.roots?.() ?? []);

  return async (args: FileToolInput): Promise<JsonValue> => {
    // The AI SDK does not validate jsonSchema tool input; these are whatever the model emitted.
    const parsed = v.safeParse(ActionSchema, args.action);

    if (!parsed.success) {
      return failure('bad_input', unknownActionError('file', 'action', args.action, FILE_TOOL_ACTIONS));
    }

    const parsedPath = v.safeParse(PathSchema, args.path);

    if (!parsedPath.success) return failure('bad_input', 'file requires `path`.');
    const path = parsedPath.output;

    if (parsed.output === 'write' || parsed.output === 'edit') requireBuild('file.' + parsed.output);

    switch (parsed.output) {
      case 'list':
        return inspect('list', path, async () => boundListing(path, await vfs.readdir(path)));
      case 'stat':
        return inspect('stat', path, async () => {
          const stat = await vfs.stat(path);

          return stat === null ? null : { path, size: stat.size, mtimeMs: stat.mtimeMs, isDir: stat.isDir };
        });
      case 'search': {
        const query = v.safeParse(QuerySchema, args.query);

        if (!query.success) return failure('bad_input', 'file search requires a non-empty literal query');

        return inspect('search', path, async (): Promise<JsonValue> => {
          const head = await readFileHead(vfs, path, FILE_SEARCH_MAX_BYTES);
          const matches = searchLines(head.text, query.output);

          return head.total !== null && head.total > head.bytes
            ? { path, matches, truncated: { shown: head.bytes, total: head.total } }
            : { path, matches };
        });
      }

      case 'read': {
        const maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS;
        let scanned: ScannedFile;

        // Reads every byte (the ledger keys on the whole-content fingerprint) but retains
        // only this window and the running hash.
        try {
          scanned = await scanFileWindow(vfs, path, { offset: args.offset, limit: args.limit, maxChars });
        } catch (err) {
          const vfsFail = await vfsFailure(vfs, { error: err }, 'read', path);

          return failure(vfsFail.reason, vfsFail.error);
        }

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
        if (args.content === undefined) return failure('bad_input', 'file action=write requires `content`.');
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

        const content = args.content;

        try {
          await persist(path, content, () => ledger.observeWhole(path, content));
        } catch (err) {
          const vfsFail = await vfsFailure(vfs, { error: err }, 'write', path);

          return failure(vfsFail.reason, vfsFail.error);
        }

        return { ok: true, path, reference: referenceOf(path), bytes: args.content.length, action: existing === null ? 'created' : 'replaced' };
      }

      case 'edit': {
        const raw = Array.isArray(args.edits) ? args.edits : [];

        if (raw.length === 0) {
          return failure('bad_input', 'file action=edit requires `edits`: [{ old_text, new_text }].');
        }

        // A missing new_text must not default to deleting the match.
        const EditInputSchema = v.object({ old_text: v.string(), new_text: v.string() });
        const malformed = raw.findIndex((edit) => !v.safeParse(EditInputSchema, edit).success);

        if (malformed !== -1) {
          return failure('bad_input',
            `edits[${malformed}] needs both old_text and new_text. ` +
            'old_text is the text to find; new_text replaces it, and "" deletes it.');
        }

        const edits: FileEdit[] = v.parse(v.array(EditInputSchema), raw)
          .map((edit) => ({ oldText: edit.old_text, newText: edit.new_text }));

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

        try {
          // Coverage carries across the edit: only the named span changed.
          await persist(path, outcome.content, writtenRevision => ledger.observeEdited(path, current, outcome.content, writtenRevision), revision);
        } catch (err) {
          const vfsFail = await vfsFailure(vfs, { error: err }, 'edit', path);
          ledger.recordEdit(path, vfsFail.reason);

          return failure(vfsFail.reason, vfsFail.error);
        }

        ledger.recordEdit(path, null);

        return {
          ok: true,
          path,
          reference: referenceOf(path),
          applied: outcome.applied.map((a) => ({ line: a.line, removed_lines: a.removedLines, added_lines: a.addedLines })),
        };
      }
    }
  };
}

/** The native `file` tool — a thin AI-SDK wrapper around createFileDispatcher. */
export function createFileTool(deps: FileToolDeps): ToolSet[string] {
  const run = createFileDispatcher(deps);

  return permitInPlan(tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.file,
    inputSchema: jsonSchema<FileToolInput>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...FILE_TOOL_ACTIONS],
          description: 'read contents, list a directory, stat a path, search a file for literal text, edit exact text, or write a whole file.',
        },
        path: { type: 'string', description: 'Path in this agent\'s own durable workspace filesystem; relative paths resolve at its root. Mounted executors\' files also appear under their mounts — a bound container at /sandbox, a connected device at /pc. Other environments have their own filesystems, reached through their namespaces in eval.' },
        offset: { type: 'number', description: 'For action=read: 1-indexed first line to return (default 1).' },
        limit: { type: 'number', description: 'For action=read: how many lines to return (default: as many as fit).' },
        content: { type: 'string', description: 'For action=write: the file\'s complete new contents.' },
        query: { type: 'string', description: 'For action=search: literal text to find in this file; returns matching lines and line numbers.' },
        edits: {
          type: 'array',
          description: 'For action=edit: replacements, all matched against the file as you read it and applied together or not at all.',
          items: {
            type: 'object',
            properties: {
              old_text: { type: 'string', description: 'Text to replace, copied exactly from the file — indentation, blank lines and all — with enough context around it to occur exactly once.' },
              new_text: { type: 'string', description: 'What replaces it. Empty string deletes the matched text.' },
            },
            required: ['old_text', 'new_text'],
          },
        },
      },
      required: ['action', 'path'],
    }),
    execute: async (args: FileToolInput) => run(args),
  }));
}
