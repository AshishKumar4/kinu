/**
 * `file` — the built-in file plane: read, edit, write.
 *
 * Everything here goes through `rt.storage.vfs`, which IS the CompositeVFS, so
 * one implementation reaches `/local`, `/workspace`, `/sandbox`, `/nimbus` and
 * `/pc` on both backends. There is deliberately no second filesystem path and no
 * per-runtime variant: a mount that is reserved or offline answers with its own
 * ENXIO reason, which is more useful than a tool that pretends not to exist.
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
import type { Memory, VFS } from '../types/primitives.js';
import type { TurnContextBudget } from '../context-budget.js';
import { isVfsError, vfsAddressingHint } from '../vfs/errno.js';
import { ensureDir, vfsDirname } from '../utils/vfs-helpers.js';
import { memoryIndexPath } from '../memory/note.js';
import { BUILTIN_TOOL_DESCRIPTIONS } from './registry.js';
import { applyFileEdits, readFileSlice, BOM, type FileEdit } from './file-edit.js';
import {
  TurnFileLedger, type FileEditOutcomeReason, type FileSeenNeed, type FileSeenVerdict,
} from './file-ledger.js';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from './clamp.js';

export interface FileToolDeps {
  /** The agent's composite filesystem (rt.storage.vfs). */
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

interface FileToolInput {
  action: 'read' | 'write' | 'edit';
  path: string;
  offset?: number;
  limit?: number;
  content?: string;
  edits?: Array<{ old_text?: string; new_text?: string }>;
}

/** A VFS failure, rendered for the model and classified for the ledger. */
async function vfsFailure(vfs: VFS, err: unknown, action: string, path: string): Promise<{
  reason: FileEditOutcomeReason;
  error: string;
}> {
  if (!isVfsError(err)) {
    return { reason: 'io', error: `${action} ${path} failed: ${err instanceof Error ? err.message : String(err)}` };
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

export function createFileTool(deps: FileToolDeps): ToolSet[string] {
  const { vfs, ledger, budget } = deps;

  /** Text of a file. A VFS is free to answer `{encoding:'utf8'}` with bytes;
   *  decoding beats an unchecked cast that would throw out of `execute`. */
  const readText = async (path: string): Promise<string> => {
    const raw = await vfs.readFile(path, { encoding: 'utf8' });
    return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
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
   *  the ledger's verdict with the refusal it earns, so the caller reports the
   *  reason it already computed rather than asking twice. */
  const gate = (path: string, current: string, action: 'edit' | 'overwrite'): {
    verdict: FileSeenVerdict;
    refusal: string | null;
  } => {
    const need: FileSeenNeed = action === 'edit' ? 'part' : 'whole';
    const verdict = ledger.seenState(path, current, need);
    switch (verdict.state) {
      case 'seen':
        return { verdict, refusal: null };
      case 'partial':
        return { verdict, refusal:
          `You have read only lines 1-${verdict.coveredTo} of ${verdict.total} in ${path}, so replacing it ` +
          `would discard ${verdict.total - verdict.coveredTo} lines you have not seen. ` +
          `Change part of it with action=edit, or read the rest first (action=read path=${path} offset=${verdict.coveredTo + 1}).` };
      case 'stale':
        return { verdict, refusal:
          `${path} changed since you read it. Read it again (action=read path=${path}) before you ` +
          (action === 'edit' ? 'edit it — the text you are matching may have moved.' : 'replace it, so you know what you are discarding.') };
      case 'never':
        return { verdict, refusal:
          `${path} has not been read here yet, so ${action === 'edit' ? 'editing' : 'overwriting'} it would be blind. ` +
          `Call action=read path=${path} first` +
          (action === 'edit' ? ', then copy old_text out of what it returns.' : '.') };
    }
  };

  return tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.file,
    inputSchema: jsonSchema<FileToolInput>({
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'edit'],
          description: 'read the file, edit exact text inside it, or write it whole.',
        },
        path: { type: 'string', description: 'Absolute path. /local is this agent\'s durable filesystem; the other roots are live windows into the execution environments listed for this turn.' },
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
    execute: async (args: FileToolInput) => {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (!path) return { error: 'file requires `path`.' };

      switch (args.action) {
        case 'read': {
          let content: string;
          try {
            content = await readText(path);
          } catch (err) {
            return { error: (await vfsFailure(vfs, err, 'read', path)).error };
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
          if (typeof args.content !== 'string') return { error: 'file action=write requires `content`.' };
          let existing: string | null = null;
          try {
            existing = await readText(path);
          } catch (err) {
            if (!isVfsError(err) || err.code !== 'ENOENT') {
              return { error: (await vfsFailure(vfs, err, 'write', path)).error };
            }
          }
          if (existing !== null) {
            const { refusal } = gate(path, existing, 'overwrite');
            if (refusal) return { error: refusal };
          }
          const content = args.content;
          try {
            await persist(path, content, () => ledger.observeWhole(path, content));
          } catch (err) {
            return { error: (await vfsFailure(vfs, err, 'write', path)).error };
          }
          return { ok: true, path, bytes: args.content.length, action: existing === null ? 'created' : 'replaced' };
        }

        case 'edit': {
          const raw = Array.isArray(args.edits) ? args.edits : [];
          if (raw.length === 0) {
            return { error: 'file action=edit requires `edits`: [{ old_text, new_text }].' };
          }
          // A malformed edit must not be read as the destructive option: a
          // missing new_text would otherwise default to deleting the match.
          const malformed = raw.findIndex((e) => typeof e?.old_text !== 'string' || typeof e?.new_text !== 'string');
          if (malformed !== -1) {
            return { error:
              `edits[${malformed}] needs both old_text and new_text. ` +
              'old_text is the text to find; new_text replaces it, and "" deletes it.' };
          }
          const edits: FileEdit[] = raw.map((e) => ({ oldText: e.old_text as string, newText: e.new_text as string }));

          let current: string;
          try {
            current = await readText(path);
          } catch (err) {
            const failure = await vfsFailure(vfs, err, 'edit', path);
            ledger.recordEdit(path, failure.reason);
            return { error: failure.error };
          }

          const { verdict, refusal } = gate(path, current, 'edit');
          if (refusal) {
            ledger.recordEdit(path, verdict.state === 'stale' ? 'stale' : 'unread');
            return { error: refusal };
          }

          const outcome = applyFileEdits(current, edits, path);
          if (!outcome.ok) {
            ledger.recordEdit(path, outcome.reason);
            return { error: outcome.message };
          }
          try {
            // Coverage carries across the edit: only the span the model named
            // itself changed, so what it knew about the file it still knows.
            await persist(path, outcome.content, () => ledger.observeEdited(path, current, outcome.content));
          } catch (err) {
            const failure = await vfsFailure(vfs, err, 'edit', path);
            ledger.recordEdit(path, failure.reason);
            return { error: failure.error };
          }
          ledger.recordEdit(path, null);
          return {
            ok: true,
            path,
            applied: outcome.applied.map((a) => ({ line: a.line, removed_lines: a.removedLines, added_lines: a.addedLines })),
          };
        }

        default:
          // Only a model that ignored the enum lands here. Naming the action
          // back is what lets it correct itself.
          return { error: `unknown file action '${String(args.action)}'` };
      }
    },
  });
}
