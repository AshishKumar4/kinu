/**
 * What an agent did, turn by turn, read from its own chat (1018-xao: Muse's activity log, "a full log of what it did").
 * Nothing is stored for it: each entry is a turn of the transcript, said as what set it off (the person, an event that
 * woke it, or its own work), what it did in a few words (the turn's written title, else its calls' phase title, else
 * its reply's first line), and what it changed (each call that changes something, a program by the host's record).
 */
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import type { ProgramEffects } from '../execution/call-effects';
import { describeToolCall, toolCallEffect } from '../tools/tool-call-summary';
import type { ChatHistoryEntry } from '../types/chat';
import { restoredRows, rowText } from '../utils/ui-message';
import { classifyProgrammaticTurn, eventSourceLabel, eventVariantLabel, parseDrainedEvents, turnFailure } from './background-event';
import { partInput, partProgramEffects, type AnyToolPart } from './tool-call-grouping';
import { phaseTitle, writtenTitles } from './tool-phase-title';

/** What set a turn off: the person's words, an event that woke the agent, or its own work (a job, a task it was given). */
export type ActivityCause =
  | { readonly kind: 'you'; readonly text: string }
  | { readonly kind: 'event'; readonly label: string; readonly source: string; readonly brief: string; readonly more: number }
  | { readonly kind: 'self' };

export interface ActivityEntry {
  /** The turn's first reply, which the chat scrolls to. */
  readonly id: string;
  readonly at: number;
  readonly cause: ActivityCause;
  readonly did: string;
  /** Each change, one line: a program's receipt, else the call's own words. */
  readonly changed: readonly string[];
  /** Why the turn stopped short, when it did. */
  readonly failed: string | null;
}

const LINE = 96;

function clip(text: string): string {
  const [first = ''] = text.trim().split('\n');

  return first.length > LINE ? `${first.slice(0, LINE - 1).trimEnd()}…` : first;
}

function plural(count: number, one: string): string {
  return `${String(count)} ${one}${count === 1 ? '' : 's'}`;
}

/** Operations named while they are few, each with its count past one; else counted. */
const NAMED_OPERATIONS = 2;

function operationsOf(operations: Readonly<Record<string, number>>): string | null {
  const named = Object.entries(operations);
  const total = named.reduce((sum, [, count]) => sum + count, 0);

  if (total === 0) return null;

  if (named.length > NAMED_OPERATIONS) return plural(total, 'other change');

  return named.map(([name, count]) => (count > 1 ? `${name} ×${String(count)}` : name)).join(', ');
}

/** A program's record in one line, as its call's receipt says it; null when it holds nothing to say. */
export function receiptSummary(effects: ProgramEffects): string | null {
  const failed = effects.commands.filter((command) => command.exitCode !== 0).length;
  const [only] = effects.files;

  const parts = [
    effects.files.length === 1 && only !== undefined ? `Changed ${only.path}` : null,
    effects.files.length > 1 ? `Changed ${plural(effects.files.length, 'file')}` : null,
    effects.commands.length > 0 ? `ran ${plural(effects.commands.length, 'command')}${failed > 0 ? `, ${String(failed)} failed` : ''}` : null,
    operationsOf(effects.operations),
    (effects.more ?? 0) > 0 ? `${String(effects.more)} more` : null,
  ].filter((part) => part !== null);

  const [head, ...rest] = parts;

  if (head === undefined) return null;

  // A sentence's verb opens with a capital; an operation's own name keeps its case.
  return [head.startsWith('ran ') ? `R${head.slice(1)}` : head, ...rest].join(' · ');
}

/** What one settled call changed, in a line; null for a call that only read, or whose effect nothing records. */
function changeOf(part: AnyToolPart): string | null {
  const record = partProgramEffects(part);

  if (record !== null) return receiptSummary(record);

  const name = getToolName(part);

  if (toolCallEffect(name, partInput(part)) !== 'mutate') return null;

  const said = describeToolCall(name, partInput(part));

  return said === '' ? null : said;
}

function settled(part: UIMessage['parts'][number]): part is AnyToolPart {
  return isToolUIPart(part) && (part.state === 'output-available' || part.state === 'output-error');
}

function causeOf(row: UIMessage): ActivityCause {
  const turn = classifyProgrammaticTurn({ metadata: row.metadata });

  if (turn === null || turn.kind === 'owner_answer') return { kind: 'you', text: clip(rowText(row)) };

  if (turn.kind !== 'event_drain') return { kind: 'self' };

  const [first, ...rest] = parseDrainedEvents(rowText(row));

  if (first === undefined) return { kind: 'self' };

  return { kind: 'event', label: eventVariantLabel(first.variant), source: eventSourceLabel(first.source), brief: clip(first.brief), more: rest.length };
}

/** A turn's replies, with what set it off and when its first reply landed. */
interface Turn {
  readonly cause: ActivityCause;
  readonly replies: UIMessage[];
  readonly at: number;
}

function entryOf({ cause, replies, at }: Turn): ActivityEntry | null {
  const [first] = replies;
  const last = replies.at(-1);

  if (first === undefined || last === undefined) return null;

  const calls = replies.flatMap((reply) => reply.parts.filter(settled));
  const changed = [...new Set(calls.flatMap((call) => changeOf(call) ?? []))];
  const did = writtenTitles({ metadata: first.metadata }).turn ?? (phaseTitle(calls) || clip(rowText(last)));

  return { id: first.id, at, cause, did: did === '' ? 'Answered' : did, changed, failed: turnFailure({ metadata: last.metadata }) };
}

function timeOf(entry: ChatHistoryEntry): number {
  return typeof entry.createdAt === 'number' ? entry.createdAt : Date.parse(entry.createdAt);
}

/** The turns of a chat's rows (oldest first, as its pages are drawn), newest first. A turn opens at a row the person
 *  or an event wrote and runs over the agent's replies to it; replies with nothing before them are its own work. */
export function activityOf(entries: readonly ChatHistoryEntry[]): ActivityEntry[] {
  const turns: Turn[] = [];
  let cause: ActivityCause = { kind: 'self' };
  let open: Turn | null = null;

  for (const entry of entries) {
    const [row] = restoredRows([entry]);

    if (row === undefined || entry.role === 'system') continue;

    if (row.role === 'user') {
      cause = causeOf(row);
      open = null;
      continue;
    }

    if (open === null) {
      open = { cause, replies: [], at: timeOf(entry) };
      turns.push(open);
      cause = { kind: 'self' };
    }

    open.replies.push(row);
  }

  return turns.flatMap((turn) => entryOf(turn) ?? []).reverse();
}
