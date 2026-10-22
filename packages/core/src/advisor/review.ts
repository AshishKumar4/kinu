// The advisor's notes: the rules its model answers by, the judgement every note passes, and how a note is said.
// Stateless: notes, delivery and recording arrive as arguments; the session advisor (session-advisor.ts) holds the state.

import * as v from 'valibot';
import type { ActorHandle } from '../identity/actor-handle';
import type { AgentSignal, SendOutcome } from '../types/signals';
import { ADVISOR_SEVERITIES, type AdvisorSeverity } from '../types/advisor';

export {
  ADVISOR_SEVERITIES, DEFAULT_ADVISOR_MIN_SEVERITY, type AdvisorSeverity,
} from '../types/advisor';

export const ADVISOR_SEVERITY_LABEL = {
  nit: 'Nit',
  concern: 'Concern',
  blocker: 'Blocker',
} as const satisfies Readonly<Record<AdvisorSeverity, string>>;

/** Order matches {@link ADVISOR_RULES}. `missed-capability` is the signal `turn_ratings` cannot carry:
 *  a capability the turn had and did not use. */
const ADVISOR_NOTE_CLASSES = ['wrong-work', 'missed-capability', 'dissatisfaction'] as const;

/** A note past this is cut to it, not refused. */
export const ADVISOR_NOTE_MAX_CHARS = 240;

type AdvisorNoteClass = (typeof ADVISOR_NOTE_CLASSES)[number];

export function isAdvisorNoteClass<Value>(value: Value): value is Value & AdvisorNoteClass {
  return ADVISOR_NOTE_CLASSES.some((noteClass) => noteClass === value);
}

/** Also what makes the chat render the signal as a card instead of a user bubble. */
export const ADVISOR_SIGNAL_KIND = 'advisor';

export const ADVISOR_SEVERITY_METADATA_KEY = 'advisorSeverity';

/** The review alone, as its card shows it; the turn's text adds the header the agent reads it under. */
export const ADVISOR_NOTE_METADATA_KEY = 'advisorNote';

/** Written and read back ({@link recentAdvisorNotes}) under one string. */
export const ADVISOR_EVENT_TYPE = 'advisor_note';

export interface AdvisorNote {
  readonly note: string;
  readonly severity: AdvisorSeverity;
  readonly class: AdvisorNoteClass;
}

/** What an `advisor_note` row's data holds. `turnId` is null for a turn with no durable id (programmatic wake); such a
 *  note is deduped but scores nothing. */
const AdvisorRowDataSchema = v.object({
  severity: v.picklist(ADVISOR_SEVERITIES),
  class: v.picklist(ADVISOR_NOTE_CLASSES),
  turnId: v.nullable(v.string()),
  /** Said to the reviewed actor, not only written to the Changelog; a delivery cut short says it again. */
  spoken: v.optional(v.boolean()),
});

export type AdvisorRowData = v.InferOutput<typeof AdvisorRowDataSchema>;

/** The guard is code, not prompt rules: one oh-my-pi session logged 309 `advise` calls, 114 of them "Stop."
 *  (`https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/advisor/emission-guard.ts#L9-L16`). */
type SuppressionRule = 'duplicate' | 'content-free' | 'gate-open' | 'below-floor';

type AdvisorDisposition =
  | 'deliver'
  /** Record it and stay quiet: one `evolution_events` row the owner can read. */
  | 'changelog'
  | 'drop';

export interface NoteVerdict {
  readonly disposition: AdvisorDisposition;
  /** Null exactly when the disposition is `deliver`. */
  readonly rule: SuppressionRule | null;
}

/** Lowercase, non-alphanumeric runs collapsed, so "Stop." and "Stop!" dedupe together. */
export function normalizeNote(note: string): string {
  return note.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** A window, not a lifetime: a concern that returns weeks later is worth saying again. */
export const ADVISOR_DEDUPE_WINDOW = 50;

/** Normalised forms, compared against {@link normalizeNote}'s output. Kept short: a growing blocklist hides a model problem. */
const CONTENT_FREE_NOTES: readonly string[] = [
  'stop',
  'ok',
  'okay',
  'fine',
  'good',
  'looks good',
  'lgtm',
  'no issues',
  'no issues found',
  'nothing to add',
  'no concerns',
  'continue',
  'proceed',
  'carry on',
  'keep going',
  'no comment',
  'n a',
];

export function isContentFree(note: string): boolean {
  const normalized = normalizeNote(note);

  return normalized.length === 0 || CONTENT_FREE_NOTES.includes(normalized);
}

/** `recent` is the normalised text of advisor rows already in the audit stream. */
export function isDuplicateNote(note: string, recent: readonly string[]): boolean {
  return recent.includes(normalizeNote(note));
}

/** A content-free note is dropped whole; every other unsaid note is stored. While the completion gate holds the turn,
 *  the note goes to the changelog: one runtime voice per boundary. */
export function judgeNote(opts: {
  readonly note: AdvisorNote;
  readonly minSeverity: AdvisorSeverity;
  readonly recent: readonly string[];
  readonly gateOpen: boolean;
}): NoteVerdict {
  if (isContentFree(opts.note.note)) return { disposition: 'drop', rule: 'content-free' };

  if (isDuplicateNote(opts.note.note, opts.recent)) return { disposition: 'drop', rule: 'duplicate' };

  if (opts.gateOpen) return { disposition: 'changelog', rule: 'gate-open' };
  const rank = (severity: AdvisorSeverity): number => ADVISOR_SEVERITIES.indexOf(severity);

  if (rank(opts.note.severity) < rank(opts.minSeverity)) {
    return { disposition: 'changelog', rule: 'below-floor' };
  }

  return { disposition: 'deliver', rule: null };
}

/** What the advisor says something about, and what it stays silent on. Silence is the stated default: a reviewer asked
 *  to review always finds something. Negative space ported from
 *  https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/advisor/system.md. */
export const ADVISOR_RULES: readonly string[] = [
  'Say something only when the work shows a problem the agent would act on. The classes that count:',
  '',
  '- "wrong-work": work that does not do what was asked, a check it skipped, a wrong',
  '  assumption it is about to build on, a failure it read as a success.',
  '- "missed-capability": a capability it HAD and did not use, where using it was the',
  '  right shape for the work: parallel or exploratory work ground through serially, or',
  '  deep work answered thinly, while a delegation or search capability sat unused. Name the',
  '  capability and the moment it should have been used. Only from its reachable capabilities:',
  '  if a capability is not among them the agent did not have it, and there is nothing to say.',
  '- "dissatisfaction": visible dissatisfaction from the user: explicit frustration, or a',
  '  correction that spells out what they wanted. QUOTE the user\'s own words in the note:',
  '  their wording is the evidence, and a paraphrase loses what they actually asked for.',
  '',
  'Stay silent on these, however plainly you notice them:',
  '- Size and ambition. A large diff, a wholesale rewrite or a growing plan is not a problem by',
  '  itself, and is usually what was asked for. Object only where it contradicts something the user',
  '  said, and quote the instruction when you do.',
  '- Backwards compatibility, unless the user or a standing project rule asked for it. Deleting the',
  '  old path and updating every caller is the default correct answer here.',
  '- Clarification and process. Never tell the agent to confirm scope, restate the ask, or check in',
  '  before acting. Intent is its lane; informed action is the default.',
  '- A decision the agent understood and committed to, unless what you read shows it wrong.',
  '- Anything the agent has already read: a failing test, a type error, a lint message.',
  '- Work still in progress that the agent is visibly about to finish.',
  '',
  'Judge what you read. Arguments and results are windowed, and what a window drops is UNKNOWN:',
  'check it with your tools, or say nothing about it. Do not ask for reassurance.',
  '',
  `One note per problem, at most ${String(ADVISOR_NOTE_MAX_CHARS)} characters, addressed to the agent. State the`,
  'problem and what to do. No preamble, no praise, no restating the work.',
];

/** A runtime-authored message says so (as {@link COMPLETION_GATE_HEADER}): the model only has the prose, and would
 *  obey an advisory it read as the user's instruction. */
export const ADVISOR_HEADER =
  '[Advisor: a second model is reviewing your work as you go. This is the Kinu '
  + 'runtime, not the user. Weigh it against what you know; it may be wrong.]';

/** Every advisor header opens so, this build's and the hire's before it, whose rows a card still reads. */
const ADVISOR_HEADER_OPENING = '[Advisor: ';

const labelLine = (severity: AdvisorSeverity): string => `\n\n${ADVISOR_SEVERITY_LABEL[severity]}: `;

const advisorPrefix = (severity: AdvisorSeverity): string => `${ADVISOR_HEADER}${labelLine(severity)}`;

function advisorSignalText(note: AdvisorNote): string {
  return `${advisorPrefix(note.severity)}${note.note}`;
}

/** The actor line a blocker said to the reviewed actor's parent opens with. */
const FORWARDED_ACTOR_LINE = /^\[Actor [^\]\n]*\]\n/u;

/** The note alone, from a row written before it was kept beside its text: the text less the header the agent reads it
 *  under, and less the actor line a parent's copy opens with; null when the text is not in that shape. */
export function keptAdvisorNote(text: string, severity: AdvisorSeverity): string | null {
  const said = text.replace(FORWARDED_ACTOR_LINE, '');
  const label = said.indexOf(labelLine(severity));

  if (!said.startsWith(ADVISOR_HEADER_OPENING) || label < 0 || said.lastIndexOf(']', label) < 0) return null;

  return said.slice(label + labelLine(severity).length);
}

/**
 * A recorded note said to the reviewed actor, and a blocker to its parent too. Keyed on the turn, so a note said
 * again after a cut delivery collapses onto the turn it already opened; no key without a durable id.
 */
export async function sayAdvisorNote(note: AdvisorNote, deps: {
  readonly turnId: string | undefined;
  /** Which of the turn's notes this is, where a turn may say more than one. */
  readonly key?: string;
  readonly send: (signal: AgentSignal) => Promise<SendOutcome>;
  readonly actor?: ActorHandle;
  readonly parent?: (signal: AgentSignal) => Promise<SendOutcome>;
}): Promise<SendOutcome> {
  const signal: AgentSignal = {
    kind: ADVISOR_SIGNAL_KIND,
    text: advisorSignalText(note),
    severity: note.severity,
    metadata: { [ADVISOR_SEVERITY_METADATA_KEY]: note.severity, [ADVISOR_NOTE_METADATA_KEY]: note.note },
  };

  const keyed: AgentSignal = deps.turnId === undefined || deps.turnId === ''
    ? signal
    : { ...signal, idempotencyKey: `${deps.actor === undefined
      ? `advisor:${deps.turnId}` : `advisor:${deps.actor.actorId}:${deps.turnId}`}${deps.key === undefined ? '' : `:${deps.key}`}` };

  const sent = await deps.send(keyed);

  if (note.severity === 'blocker' && deps.actor !== undefined && deps.parent !== undefined) {
    await deps.parent({ ...keyed, text: `[Actor ${deps.actor.name}]\n${keyed.text}` });
  }

  return sent;
}
