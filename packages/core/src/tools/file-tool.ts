/**
 * `file` — the built-in file plane: read, edit, write.
 *
 * Everything here goes through `rt.storage.vfs`, the workspace filesystem, on
 * both backends. There is deliberately no second filesystem path and no
 * per-runtime variant: another environment is reached through its own
 * namespace, in its own paths, rather than through a prefix here.
 *
 * Why one tool with three actions rather than three tools: reading a file,
 * replacing text inside it and creating it are one concept — the file plane —
 * and which action a call needs follows from what the model is doing, not from a
 * comparison it must make. That is the same reason `memory` is one tool and
 * `web` is one tool. They also share everything underneath: one path vocabulary,
 * one error vocabulary, one read ledger, one durable outcome counter.
 */

import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import * as v from 'valibot';
import type { Memory, VFS } from '../types/primitives';
import type { TurnContextBudget } from '../context-budget';
import { isVfsError, vfsAddressingHint } from '../vfs/errno';
import { ensureDir, vfsDirname } from '../utils/vfs-helpers';
import { memoryIndexPath } from '../memory/note';
import {
  BUILTIN_TOOL_DESCRIPTIONS, FILE_TOOL_ACTIONS, unknownActionError, type FileToolAction,
} from './registry';
import { applyFileEdits, readFileSlice, BOM, type FileEdit } from './file-edit';
import { TurnFileLedger, type FileEditOutcomeReason, type FileSeenNeed } from './file-ledger';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from './clamp';
import type { JsonValue } from '../utils/json';
import { renderThrownChain } from '../obs/index';

export interface FileToolDeps {
  /** The agent's canonical workspace filesystem (rt.storage.vfs). */
  vfs: VFS;
  /** The turn's read/edit ledger. */
  ledger: TurnFileLedger;
  /** The turn's bulk budget — a file read is bulk like any other tool result,
   *  so it is capped by the same turn-cumulative rule. */
  budget: TurnContextBudget;
  /** Long-term memory, so a write under `memory/` re-indexes exactly as
   *  `workspace.writeFile` does. Without it the FTS index would silently go
   *  stale for the one directory whose whole purpose is being searchable. */
  memory?: Memory;
}

export interface FileToolInput {
  action: FileToolAction;
  path: string;
  offset?: number;
  limit?: number;
  content?: string;
  edits?: Array<{ old_text?: string; new_text?: string }>;
}

/** What the read-before-write gate decided: the refusal the model is shown and
 *  the reason that classifies it, or both null when the operation may proceed. */
interface GateVerdict {
  readonly refusal: string | null;
  readonly reason: FileEditOutcomeReason | null;
}

/**
 * Why a `file` call did not do what it was asked, on the result the MODEL
 * receives — the ledger's own reason vocabulary plus the one case the ledger
 * cannot hold: a call whose arguments were malformed never became an edit
 * attempt, so counting it among them would inflate `attempts`.
 *
 * It is on the result because the dispatcher already computes it at every
 * failure site and, until now, threw it away there: the reason reached the
 * per-TURN counters in the `file_edit` event and nothing else, so a durable
 * `tool_call_end` row could say a `file` call failed and never which of nine
 * distinct things happened. Nine reasons collapsed to one bit is why "why do
 * the tool calls fail" was unanswerable from the ledger.
 */
export type FileToolFailureReason = FileEditOutcomeReason | 'bad_input';

/** A failure result, reason FIRST. Every seam that shows a tool result to a
 *  human or a steering hash bounds it to a head slice (1000 chars), and the
 *  refusal prose is the long part — so the discriminator leads, where no clamp
 *  can reach it. */
function failure(reason: FileToolFailureReason, error: string): JsonValue {
  return { reason, error };
}

/** A VFS failure, rendered for the model and classified for the ledger. */
async function vfsFailure(vfs: VFS, input: { error: unknown }, action: string, path: string): Promise<{
  reason: FileEditOutcomeReason;
  error: string;
}> {
  const err = input.error;
  if (!isVfsError(err)) {
    return { reason: 'io', error: `${action} ${path} failed: ${renderThrownChain({ cause: err })}` };
  }
  const reason: FileEditOutcomeReason = err.code === 'ENOENT' ? 'missing' : 'io';
  // ENOENT and EISDIR are the model's own addressing mistakes, and the hint
  // names this agent's real roots. Everything else (a reserved mount, an
  // offline device, a read-only plane) already carries its own reason.
  const hint = err.code === 'ENOENT' || err.code === 'EISDIR'
    ? ` — ${await vfsAddressingHint(vfs, 'the `file` tool\'s path')}`
    : '';
  return { reason, error: `${err.message}${hint}` };
}

/**
 * The file plane's dispatch logic — read / write / edit over one VFS,
 * ledger and budget. Factored out so codemode's `workspace.writeFile` and
 * `workspace.editFile` call the SAME implementation as the native `file`
 * tool, sharing the SAME TurnFileLedger. A guarded write refuses identically
 * regardless of surface, and a read/write/edit through one is known to the
 * other.
 */
export function createFileDispatcher(deps: FileToolDeps): (input: FileToolInput) => Promise<JsonValue> {
  const { vfs, ledger, budget } = deps;

  /** Text of a file. A VFS is free to answer `{encoding:'utf8'}` with bytes;
   *  decoding beats an unchecked cast that would throw out of `execute`. */
  const readText = async (path: string): Promise<string> => {
    const raw = await vfs.readFile(path, { encoding: 'utf8' });
    const text = v.safeParse(v.string(), raw);
    return text.success
      ? text.output
      : new TextDecoder().decode(v.parse(v.instance(Uint8Array), raw));
  };

  /** The one write path. `observe` runs the moment the bytes land — a later
   *  step failing must not leave the ledger denying content already on disk —
   *  and differs only in what the caller now knows: a `write` authored the whole
   *  file, an `edit` changed one span of what it already knew. */
  const persist = async (path: string, content: string, observe: () => void): Promise<void> => {
    const dir = vfsDirname(path);
    if (dir) await ensureDir(vfs, dir);
    await vfs.writeFile(path, content);
    observe();
    const indexed = memoryIndexPath(path);
    if (deps.memory && indexed) await deps.memory.index(indexed);
  };

  /** The read-before-write gate, shared by edit and overwriting write. Returns
   *  the refusal a verdict earns AND the reason that classifies it, computed
   *  once here: the two call sites used to derive the reason themselves with a
   *  ternary each, which is two places for one rule.
   *
   *  `partial` classifies as `unread` — read to less depth than the operation
   *  needs is the same defect as not read at all, and the prose is what
   *  distinguishes them for the model. It is only reachable on `whole`. */
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

  return async (args: FileToolInput): Promise<JsonValue> => {
    // Declared types, not established ones: the AI SDK leaves
    // `Schema.validate` undefined for a jsonSchema-declared tool input, so both
    // of these are whatever the model emitted. `path.trim()` on a non-string
    // threw out of the tool instead of answering, and an unrecognised action
    // was answered without naming the three that work.
    const parsed = v.safeParse(ActionSchema, args.action);
    if (!parsed.success) {
      return failure('bad_input', unknownActionError('file', 'action', args.action, FILE_TOOL_ACTIONS));
    }
    const parsedPath = v.safeParse(PathSchema, args.path);
    if (!parsedPath.success) return failure('bad_input', 'file requires `path`.');
    const path = parsedPath.output;

    switch (parsed.output) {
      case 'read': {
        let content: string;
        try {
          content = await readText(path);
        } catch (err) {
          const vfsFail = await vfsFailure(vfs, { error: err }, 'read', path);
          return failure(vfsFail.reason, vfsFail.error);
        }
        const configured = DEFAULT_TOOL_RESULT_MAX_CHARS;
        const cap = budget.capFor(configured);
        // The BOM is stripped from what the model is SHOWN, not from the file:
        // it is invisible, so a model copying the first line back as old_text
        // would carry it and never match, with no way to see why.
        const shown = content.startsWith(BOM) ? content.slice(1) : content;
        const slice = readFileSlice(shown, { path, offset: args.offset, limit: args.limit, maxChars: cap });
        ledger.observeRange(path, content, slice.first, slice.last, slice.total);
        budget.admit(slice.output.length);
        if (slice.omitted > 0) {
          // The full text is not spilled anywhere: it is already addressable
          // at its own path, and the marker says which offset continues it.
          budget.recordSpill({ producer: 'file_read', omitted: slice.omitted, referenced: true, tightened: cap < configured });
        }
        return slice.output;
      }

      case 'write': {
        if (args.content === undefined) return failure('bad_input', 'file action=write requires `content`.');
        let existing: string | null = null;
        try {
          existing = await readText(path);
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
        return { ok: true, path, bytes: args.content.length, action: existing === null ? 'created' : 'replaced' };
      }

      case 'edit': {
        const raw = Array.isArray(args.edits) ? args.edits : [];
        if (raw.length === 0) {
          return failure('bad_input', 'file action=edit requires `edits`: [{ old_text, new_text }].');
        }
        // A malformed edit must not be read as the destructive option: a
        // missing new_text would otherwise default to deleting the match.
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
        try {
          current = await readText(path);
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
          // Coverage carries across the edit: only the span the model named
          // itself changed, so what it knew about the file it still knows.
          await persist(path, outcome.content, () => ledger.observeEdited(path, current, outcome.content));
        } catch (err) {
          const vfsFail = await vfsFailure(vfs, { error: err }, 'edit', path);
          ledger.recordEdit(path, vfsFail.reason);
          return failure(vfsFail.reason, vfsFail.error);
        }
        ledger.recordEdit(path, null);
        return {
          ok: true,
          path,
          applied: outcome.applied.map((a) => ({ line: a.line, removed_lines: a.removedLines, added_lines: a.addedLines })),
        };
      }
    }
  };
}

/** The native `file` tool — a thin AI-SDK wrapper around createFileDispatcher. */
export function createFileTool(deps: FileToolDeps): ToolSet[string] {
  const run = createFileDispatcher(deps);
  return tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.file,
    inputSchema: jsonSchema<FileToolInput>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...FILE_TOOL_ACTIONS],
          description: 'read the file, edit exact text inside it, or write it whole.',
        },
        path: { type: 'string', description: 'Path in this agent\'s own durable workspace filesystem; relative paths resolve at its root. Other environments have their own filesystems, reached through their namespaces in execute_tools.' },
        offset: { type: 'number', description: 'For action=read: 1-indexed first line to return (default 1).' },
        limit: { type: 'number', description: 'For action=read: how many lines to return (default: as many as fit).' },
        content: { type: 'string', description: 'For action=write: the file\'s complete new contents.' },
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
  });
}
