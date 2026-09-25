import * as v from 'valibot';
import type { RawSqlExec } from '../types/primitives';
import type { AgentRuntime } from '../types/agent-runtime';
import type { EnqueueTurnResult, ProgrammaticTurn } from '../types/backend-host';
import type { DiffAnchor, ReviewAnnotation } from '../types/plans';
import { admitReviewAnnotations, DiffAnchorSchema } from '../plans/review';
import { TURN_AUTHOR_METADATA_KEY } from '../utils/ui-message';
import type { JsonObject } from '../utils/json';
import { comparePaths } from './change-view';

const CHANGE_NOTES_EVENT = 'change_notes';

export const ALL_CHANGES_BLOCK = 'changes';

export function initChangeNotesTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS change_notes (
    actor_id   TEXT NOT NULL,
    source     TEXT NOT NULL,
    notes_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, source)
  )`);
}

type NotesRuntime = Pick<AgentRuntime, 'storage' | 'actor'>;

export type ChangeNotesResult =
  | { readonly ok: true; readonly notes: readonly ReviewAnnotation[] }
  | { readonly ok: false; readonly error: string };

export function readChangeNotes(rt: NotesRuntime, source: string): ReviewAnnotation[] {
  const row = rt.storage.sql<{ notes_json: string }>`SELECT notes_json FROM change_notes
    WHERE actor_id = ${rt.actor.actorId} AND source = ${source} LIMIT 1`[0];

  if (row === undefined) return [];
  const admission = admitReviewAnnotations({ value: JSON.parse(row.notes_json) });

  if (!admission.ok) throw new Error(`the notes kept on ${source} no longer admit: ${admission.error}`);

  return admission.annotations;
}

/** No await between read and delete: a later note is the next send's. */
function takeChangeNotes(rt: NotesRuntime, source: string): ReviewAnnotation[] {
  const notes = readChangeNotes(rt, source);

  void rt.storage.sql`DELETE FROM change_notes WHERE actor_id = ${rt.actor.actorId} AND source = ${source}`;

  return notes;
}

function putBack(rt: NotesRuntime, source: string, taken: readonly ReviewAnnotation[]): void {
  const ids = new Set(taken.map((note) => note.id));
  const since = readChangeNotes(rt, source).filter((note) => !ids.has(note.id));
  const global = taken.some((note) => note.type === 'GLOBAL_COMMENT');
  const kept = [...taken, ...since.filter((note) => !global || note.type !== 'GLOBAL_COMMENT')];

  void rt.storage.sql`INSERT OR REPLACE INTO change_notes (actor_id, source, notes_json, updated_at)
    VALUES (${rt.actor.actorId}, ${source}, ${JSON.stringify(kept)}, ${Date.now()})`;
}

function refusal(notes: readonly ReviewAnnotation[]): string | null {
  const loose = notes.find((note) => (note.anchor === undefined) !== (note.type === 'GLOBAL_COMMENT'));

  if (loose !== undefined) return `note ${loose.id} must be on all the changes or on a place in them, not both`;

  return notes.filter((note) => note.type === 'GLOBAL_COMMENT').length > 1 ? 'there is one note on all the changes' : null;
}

export function saveChangeNotes(rt: NotesRuntime, source: string, notes: { value: unknown }): ChangeNotesResult {
  rt.actor.assertCurrent();
  const admission = admitReviewAnnotations(notes);

  if (!admission.ok) return admission;
  const refused = refusal(admission.annotations);

  if (refused !== null) return { ok: false, error: refused };
  const actorId = rt.actor.actorId;

  if (admission.annotations.length === 0) {
    void rt.storage.sql`DELETE FROM change_notes WHERE actor_id = ${actorId} AND source = ${source}`;
  } else {
    void rt.storage.sql`INSERT OR REPLACE INTO change_notes (actor_id, source, notes_json, updated_at)
      VALUES (${actorId}, ${source}, ${JSON.stringify(admission.annotations)}, ${Date.now()})`;
  }

  return { ok: true, notes: admission.annotations };
}

const NotedChangesSchema = v.strictObject({
  source: v.pipe(v.string(), v.minLength(1)),
  label: v.pipe(v.string(), v.minLength(1)),
  mode: v.picklist(['vfs-baseline', 'git']),
  trackedSince: v.optional(v.number()),
});

export type NotedChanges = v.InferOutput<typeof NotedChangesSchema>;

function baselineName(set: NotedChanges, baseline: string): string {
  return set.mode === 'git' ? `commit ${baseline.slice(0, 7)}` : `snapshot ${baseline.slice(0, 6)}`;
}

function framing(set: NotedChanges, baseline: string | null): string {
  const since = set.trackedSince === undefined ? '' : ` since ${new Date(set.trackedSince).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const named = baseline !== null && baseline !== '';

  const base = set.mode === 'git'
    ? `On the uncommitted changes in ${set.label}'s checkout${named ? `, against ${baselineName(set, baseline)}` : ''}.`
    : `On the workspace's changes${since}${named ? ` (${baselineName(set, baseline)})` : ''}.`;

  const each = baseline === null ? ` The notes were written on more than one ${set.mode === 'git' ? 'commit' : 'snapshot'}; each file names its own.` : '';

  return `${base}${each} A line number is the file as it was when the note was written; "new" is the file now, "old" the file`
    + ' before the changes. Each note quotes its lines, so find them by the quote if the file has moved since.';
}

function heading(anchor: DiffAnchor): string {
  if (anchor.scope === 'file') return 'Whole file';
  const lines = anchor.lineStart === anchor.lineEnd ? `Line ${String(anchor.lineStart)}` : `Lines ${String(anchor.lineStart)}-${String(anchor.lineEnd)}`;

  return `${lines} (${anchor.side})`;
}

function fenced(quote: string): string {
  const longest = Math.max(2, ...[...quote.matchAll(/`+/gu)].map((run) => run[0].length));
  const fence = '`'.repeat(longest + 1);

  return `${fence}\n${quote}\n${fence}`;
}

function said(note: ReviewAnnotation): string {
  return note.type === 'DELETION' ? 'Remove this.' : note.text ?? '';
}

function firstLine(anchor: DiffAnchor | undefined): number {
  return anchor === undefined || anchor.scope === 'file' ? 0 : anchor.lineStart;
}

export function inNoteOrder(notes: readonly ReviewAnnotation[]): ReviewAnnotation[] {
  return [...notes].sort((a, b) => {
    if (a.anchor === undefined || b.anchor === undefined) return Number(a.anchor === undefined) - Number(b.anchor === undefined);

    return comparePaths(a.anchor.path, b.anchor.path) || firstLine(a.anchor) - firstLine(b.anchor);
  });
}

function changeNotesText(set: NotedChanges, notes: readonly ReviewAnnotation[]): string {
  const sorted = inNoteOrder(notes);
  const baselines = new Set(sorted.flatMap((note) => (note.anchor === undefined ? [] : [note.anchor.baseline])));
  const one = baselines.size > 1 ? null : [...baselines][0] ?? '';
  const groups = new Map<string, string[]>();

  for (const note of sorted) {
    const anchor = note.anchor;
    let title = 'All the changes';

    if (anchor !== undefined) title = one === null && anchor.baseline !== '' ? `${anchor.path} (${baselineName(set, anchor.baseline)})` : anchor.path;
    const blocks = groups.get(title) ?? [];

    groups.set(title, blocks);

    if (anchor === undefined) {
      blocks.push(said(note));
      continue;
    }

    const quote = anchor.scope === 'file' || note.originalText === '' ? '' : `\n${fenced(note.originalText)}`;
    blocks.push(`### ${heading(anchor)}${quote}\n${said(note)}`);
  }

  return ['# Notes on the changes', framing(set, one), ...[...groups].flatMap(([title, blocks]) => [`## ${title}`, ...blocks])].join('\n\n');
}

const CardNoteSchema = v.object({
  id: v.string(),
  type: v.picklist(['DELETION', 'COMMENT', 'GLOBAL_COMMENT']),
  text: v.optional(v.string()),
  anchor: v.optional(DiffAnchorSchema),
});

const ChangeNotesMetadataSchema = v.looseObject({
  kinuEvent: v.literal(CHANGE_NOTES_EVENT),
  changeNotes: v.object({ source: v.string(), label: v.string(), notes: v.array(CardNoteSchema) }),
});

export type ChangeNotesCard = v.InferOutput<typeof ChangeNotesMetadataSchema>['changeNotes'];

export function changeNotesCard(row: { metadata: unknown }): ChangeNotesCard | null {
  const parsed = v.safeParse(ChangeNotesMetadataSchema, row.metadata);

  return parsed.success ? parsed.output.changeNotes : null;
}

function changeNotesTurn(set: NotedChanges, notes: readonly ReviewAnnotation[]): ProgrammaticTurn {
  const card: JsonObject = {
    source: set.source, label: set.label,
    notes: inNoteOrder(notes).map((note) => {
      const item: JsonObject = { id: note.id, type: note.type };

      if (note.text !== undefined) item.text = note.text;

      if (note.anchor !== undefined) item.anchor = { ...note.anchor };

      return item;
    }),
  };

  return {
    text: changeNotesText(set, notes),
    metadata: { kinuEvent: CHANGE_NOTES_EVENT, [TURN_AUTHOR_METADATA_KEY]: 'operator', changeNotes: card },
    origin: 'user',
  };
}

export async function sendChangeNotes(
  rt: NotesRuntime, set: { value: unknown }, enqueue: (turn: ProgrammaticTurn) => Promise<EnqueueTurnResult>,
): Promise<ChangeNotesResult> {
  rt.actor.assertCurrent();
  const parsed = v.safeParse(NotedChangesSchema, set.value);

  if (!parsed.success) return { ok: false, error: `the change-set: ${parsed.issues[0].message}` };
  const { source } = parsed.output;
  const notes = takeChangeNotes(rt, source);

  if (notes.length === 0) return { ok: false, error: 'there are no notes to send' };
  let queued = false;

  try {
    queued = (await enqueue(changeNotesTurn(parsed.output, notes))).status === 'queued';
  } finally {
    if (!queued) putBack(rt, source, notes);
  }

  return queued ? { ok: true, notes: [] } : { ok: false, error: 'the notes were not sent: a newer turn took their place' };
}
