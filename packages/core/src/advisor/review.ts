/**
 * The advisor: a second model reads a finished turn and may say one thing
 * about it.
 *
 * Every judge this codebase already has grades a bounded pair — a task and an
 * output (evolution/outcomes.ts, scaffold/auto-judge.ts). None of them reads
 * the turn as it happened, and none of them speaks into the conversation. This
 * one does both, once per turn, and usually says nothing.
 *
 * It reads the record the turn already wrote. The `CompletedTurn` carries the
 * tool calls, their results, the step count and whether the turn errored, and
 * the prepared messages carry what the model was working from. So the advisor
 * gets no tools: re-reading files to learn what a turn did would pay for
 * evidence the runtime already holds.
 *
 * This module holds no state and owns no storage. Recent notes arrive as an
 * argument (`EvolutionEngine.recentAdvisorNotes` reads them off the audit stream
 * the engine already writes), the metered and governed `LLM` arrives as an
 * argument, and delivery and recording arrive as two functions. That is what
 * makes every suppression rule below a pure function with its own test, and it
 * is why {@link runAdvisorLane} can be the ONE turn-end policy both backends
 * call instead of the same five branches written twice.
 */

import * as v from 'valibot';
import type { LLM } from '../types/primitives';
import type { AgentSignal, SignalOutcome } from '../types/signals';
import type { CompletedTurn, ToolCallRecord } from '../evolution/types';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { stableStringify } from '../safety/argument-digest';

/** How strongly a note asks to be weighed. ORDERED: a floor is a comparison of
 *  positions in this array, so inserting a severity in the middle re-ranks it. */
export const ADVISOR_SEVERITIES = ['nit', 'concern', 'blocker'] as const;
export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];

export function isAdvisorSeverity<Value>(value: Value): value is Value & AdvisorSeverity {
  return ADVISOR_SEVERITIES.some((severity) => severity === value);
}

/** What each severity means to a reader who did not write it. */
export const ADVISOR_SEVERITY_LABEL = {
  nit: 'Nit',
  concern: 'Concern',
  blocker: 'Blocker',
} as const satisfies Readonly<Record<AdvisorSeverity, string>>;

/**
 * WHAT the note is about, in the order {@link buildAdvisorPrompt} offers the
 * three classes.
 *
 * The prompt has always asked for exactly these three and the reply threw the
 * answer away, so every note landed on the audit stream as undifferentiated
 * prose. The class is what makes an advisor row usable as evidence rather than
 * as reading material: `buildOutcomeEvalSplit` renders it into the instance a
 * judge scores, so the judge is told what KIND of failure it is grading.
 *
 *   wrong-work        — the turn did not do what was asked: a check skipped, an
 *                       assumption about to be built on, a failure read as a
 *                       success.
 *   missed-capability — a capability the turn HAD and did not use, where using
 *                       it was the right shape for the work. This is the one
 *                       signal `turn_outcomes` structurally cannot carry: the
 *                       outcome classifier grades what happened, never what was
 *                       available and went unused.
 *   dissatisfaction   — the user said so in this turn, in their own words, which
 *                       the note quotes.
 */
export const ADVISOR_NOTE_CLASSES = ['wrong-work', 'missed-capability', 'dissatisfaction'] as const;
export type AdvisorNoteClass = (typeof ADVISOR_NOTE_CLASSES)[number];

export function isAdvisorNoteClass<Value>(value: Value): value is Value & AdvisorNoteClass {
  return ADVISOR_NOTE_CLASSES.some((noteClass) => noteClass === value);
}

/** What each class means to a reader who did not write it — the phrase an eval
 *  instance carries, so a judge reads the kind and not the token. */
export const ADVISOR_CLASS_LABEL = {
  'wrong-work': 'the work did not do what was asked',
  'missed-capability': 'a capability it had and did not use',
  dissatisfaction: 'the user said they were unhappy',
} as const satisfies Readonly<Record<AdvisorNoteClass, string>>;

/**
 * The default floor for reaching the conversation.
 *
 * `concern` keeps the conversation quiet by default. A `nit` is still recorded,
 * as a Changelog row, so the owner can read what the advisor thought without
 * the agent being told about it.
 */
export const DEFAULT_ADVISOR_MIN_SEVERITY: AdvisorSeverity = 'concern';

/** The `kinuEvent` an advisor signal carries: its provenance in the run log,
 *  and what makes the chat render it as a card instead of a user bubble. */
export const ADVISOR_SIGNAL_KIND = 'advisor';

/** The turn-metadata key carrying the note's severity to the card. */
export const ADVISOR_SEVERITY_METADATA_KEY = 'advisorSeverity';

/** The `EvolutionEvent.type` a sub-threshold or held note is stored under, and
 *  the type {@link recentAdvisorNotes} reads back. One string, two directions. */
export const ADVISOR_EVENT_TYPE = 'advisor_note';

/** One thing the advisor has to say about one turn. */
export interface AdvisorNote {
  readonly note: string;
  readonly severity: AdvisorSeverity;
  readonly class: AdvisorNoteClass;
}

/**
 * The `evolution_events.data` payload of an advisor row: what the writer stamps
 * and what the scorer parses.
 *
 * One schema for both directions on purpose. A hand-rolled `json_extract` read
 * beside a hand-built write is how a payload comes to be written in one shape
 * and read in another while both sides look like they work — recorded, in this
 * repo, at `test-utils/tests/agent-evals.test.ts`. `EvolutionEngine
 * .recordAdvisorNote` types its object as this, so a field renamed on one side
 * fails to compile on the other.
 *
 * `turnId` is nullable because a turn can end with no durable id (a programmatic
 * wake). Such a note is still recorded and still deduped against; it just has no
 * conversation to join back to, so it scores nothing.
 */
export const AdvisorRowDataSchema = v.object({
  severity: v.picklist(ADVISOR_SEVERITIES),
  class: v.picklist(ADVISOR_NOTE_CLASSES),
  turnId: v.nullable(v.string()),
});

export type AdvisorRowData = v.InferOutput<typeof AdvisorRowDataSchema>;

// ── Suppression ─────────────────────────────────────────────────────────────

/**
 * Why a note did not reach the conversation.
 *
 * oh-my-pi's advisor is the recorded evidence that prose rules do not hold
 * here: one captured session logged 309 `advise` calls covering 92 unique
 * notes, 114 of them the single word "Stop."
 * (`can1357/oh-my-pi`, `packages/coding-agent/src/advisor/emission-guard.ts:9-16`).
 * So the guard is code, and each rule is one function.
 */
export type SuppressionRule = 'duplicate' | 'content-free' | 'gate-open' | 'below-floor';

/** What the caller does with the note. */
export type AdvisorDisposition =
  /** Speak it: one signal, one card, one severity. */
  | 'deliver'
  /** Record it and stay quiet: one `evolution_events` row the owner can read. */
  | 'changelog'
  /** Say nothing and store nothing. Only for a note that adds no fact. */
  | 'drop';

export interface NoteVerdict {
  readonly disposition: AdvisorDisposition;
  /** Null exactly when the disposition is `deliver`. */
  readonly rule: SuppressionRule | null;
}

/**
 * The note text as the dedupe window compares it: lowercase, with every run of
 * non-alphanumeric characters collapsed to one space.
 *
 * Comparing raw text would let "Stop." and "Stop!" both through, which is the
 * failure mode above with punctuation on it.
 */
export function normalizeNote(note: string): string {
  return note.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * How many recent notes the dedupe window holds.
 *
 * A window, not a lifetime: an advisor that never repeats itself cannot raise a
 * concern that came back weeks later, and a concern coming back is exactly the
 * thing worth saying twice. 50 is roughly a long session, which is the span
 * over which a repeat reads as nagging rather than as news.
 */
export const ADVISOR_DEDUPE_WINDOW = 50;

/**
 * Notes that carry no fact.
 *
 * Normalised forms, so the table is compared against {@link normalizeNote}'s
 * output and cannot drift from it. Short and fixed on purpose: a growing
 * blocklist of phrases is a model-behaviour problem being solved in a list.
 */
export const CONTENT_FREE_NOTES: readonly string[] = [
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

/** A note that says nothing. */
export function isContentFree(note: string): boolean {
  const normalized = normalizeNote(note);
  return normalized.length === 0 || CONTENT_FREE_NOTES.includes(normalized);
}

/** A note the workspace has already been told. `recent` is the normalised text
 *  of the advisor rows already in the audit stream. */
export function isDuplicateNote(note: string, recent: readonly string[]): boolean {
  return recent.includes(normalizeNote(note));
}

/**
 * The four rules, in the order their answers matter.
 *
 * A note that adds no fact is dropped whole — neither said nor stored, because
 * storing "Stop." helps nobody read a changelog. Everything else that cannot be
 * said is stored, so a held note is never a lost one.
 *
 * `gateOpen` is the completion gate holding this turn
 * (orchestrator/completion-gate.ts). One runtime voice per boundary: the gate
 * asked the agent a mechanical question and an advisory arriving beside it reads
 * as the same speaker contradicting itself. The advisor's note becomes a
 * Changelog row instead, and the advisor sees the turn again next time if the
 * condition still holds.
 */
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

// ── The call ────────────────────────────────────────────────────────────────

/**
 * What the model may answer.
 *
 * `note` absent, empty, or `severity` or `class` absent is the silent answer,
 * and silence is the expected one. Asking for an explicit null would make "I
 * have nothing" a shape the model has to get right.
 */
const AdvisorReplySchema = v.object({
  note: v.optional(v.string()),
  severity: v.optional(v.string()),
  class: v.optional(v.string()),
});

/** One tool call as the advisor is shown it. Arguments and result are bounded
 *  by the same per-call budget the pattern extractor uses. */
function renderToolCall(call: ToolCallRecord): string {
  const args = evidenceWindow(stableStringify(call.args), EVIDENCE_BUDGETS.patternToolCall);
  const result = call.result === undefined
    ? ''
    : `\n    → ${evidenceWindow(stableStringify(call.result), EVIDENCE_BUDGETS.patternToolCall)}`;
  return `  - ${call.name}(${args})${result}`;
}

/**
 * The reviewer's prompt.
 *
 * It states the one thing the advisor is for — the note the agent would want at
 * its next step and did not get — and it states silence as the default answer,
 * because a reviewer asked to review will always find something.
 *
 * Half its budget is negative space, ported from oh-my-pi's own watchdog prompt
 * (packages/coding-agent/src/prompts/advisor/system.md). The suppression rules in
 * this file stop a note from being REPEATED; nothing stopped it being about scope,
 * backwards compatibility, or a request for clarification — the three classes a
 * reviewer reaches for when the turn was actually fine. Each severity carries a
 * worked note inside its own length bound, so severity calibration gets the
 * treatment note content already had.
 *
 * `reachable` is the capability names the turn genuinely had (the keys of the
 * ToolSet it ran with). It is what makes the missed-capability class checkable
 * rather than speculative: without it a reviewer can only guess that delegation
 * was available, and a note naming a capability the actor never had is worse
 * than no note. Empty means the caller could not say, and then the class is
 * simply not offered.
 */
export function buildAdvisorPrompt(turn: CompletedTurn, reachable: readonly string[] = []): string {
  const tools = turn.toolCalls.length === 0
    ? '  (none)'
    : turn.toolCalls.map(renderToolCall).join('\n');
  const called = new Set(turn.toolCalls.map((call) => call.name));
  const unused = reachable.filter((name) => !called.has(name));
  return [
    'You are reviewing one finished turn of an autonomous coding agent, for the agent itself.',
    '',
    'Say something only when the turn shows a problem the agent would act on. The classes',
    'that count:',
    '',
    '- "wrong-work": work that does not do what was asked, a check it skipped, a wrong',
    '  assumption it is about to build on, a failure it read as a success.',
    '- "missed-capability": a capability it HAD and did not use, where using it was the',
    '  right shape for the work: parallel or exploratory work ground through serially, or',
    '  deep work answered thinly, while a delegation or search capability sat unused. Name the',
    '  capability and the moment it should have been used. Only from the reachable list below —',
    '  if the capability is not on that list the agent did not have it, and there is nothing to say.',
    '- "dissatisfaction": visible dissatisfaction from the user in this turn — explicit',
    '  frustration, or a correction that spells out what they wanted.',
    '  QUOTE the user\'s own words in the note.',
    '  Their wording is the evidence, and a paraphrase loses what they actually asked for.',
    '',
    'Stay silent on these, however plainly you notice them:',
    '- Size and ambition. A large diff, a wholesale rewrite or a growing plan is not a problem by',
    '  itself, and is usually what was asked for. Object only where it contradicts something the user',
    '  said in this turn, and quote the instruction when you do.',
    '- Backwards compatibility, unless the user or a standing project rule asked for it. Deleting the',
    '  old path and updating every caller is the default correct answer here.',
    '- Clarification and process. Never tell the agent to confirm scope, restate the ask, or check in',
    '  before acting. Intent is its lane; informed action is the default.',
    '- A decision the agent understood and committed to, unless the record below shows it wrong.',
    '- Anything the agent has already read: a failing test, a type error, a lint message in the record.',
    '',
    'Judge what the record below shows. Arguments and results are windowed, and what a window drops is',
    'UNKNOWN — never assert a value the record does not show. Do not guess at what is not there, and',
    'do not ask for reassurance.',
    '',
    'Silence is the normal answer. Most turns are fine.',
    '',
    `The request:\n"${evidenceWindow(turn.userMessage, EVIDENCE_BUDGETS.outcomeUserMessage)}"`,
    '',
    `What the agent answered:\n"${evidenceWindow(turn.assistantResponse, EVIDENCE_BUDGETS.outcomeAssistantResponse)}"`,
    '',
    `Tool calls (${String(turn.toolCalls.length)} across ${String(turn.steps)} steps${turn.hadError ? ', and the turn errored' : ''}):`,
    tools,
    '',
    unused.length === 0
      ? 'Reachable capabilities it did not use: (none recorded)'
      : `Reachable capabilities it did not use: ${unused.join(', ')}`,
    '',
    'Severities:',
    '- "nit": worth recording, not worth interrupting for.',
    '  e.g. "The three sequential writes to the same module could have been one edit. Nothing to redo — worth knowing next time."',
    '- "concern": the agent should weigh this before its next step.',
    '  e.g. "You read the run result as a pass, but its text starts `Error (exit 3)`. Confirm the command succeeded before building on it."',
    '- "blocker": continuing without addressing this wastes the work.',
    '  e.g. "The migration ran against the live database before the suite ran once. Stop and confirm a backup exists before continuing."',
    '',
    'One note, at most 240 characters, addressed to the agent. State the problem and what',
    'to do. No preamble, no praise, no restating the turn.',
    '',
    'JSON shape when you have something: {"note":"<the note>","severity":"nit"|"concern"|"blocker",'
      + '"class":"wrong-work"|"missed-capability"|"dissatisfaction"}',
    'JSON shape when you do not: {}',
    jsonObjectOnlyInstruction(),
  ].join('\n');
}

/**
 * The note the agent is allowed to be told, as long as the model wrote one.
 *
 * A model that answers a longer note than asked is not a failure — it is the
 * ordinary case — so the text is bounded here rather than rejected. An
 * unreadable answer, an unknown severity or an unknown class IS a failure of the
 * contract and answers null, which the caller records as a turn the advisor did
 * not review. The class is held to the same standard as the severity because the
 * two are read the same way downstream: a note whose kind nobody can name scores
 * nothing, so accepting one would put an unlabeled instance in front of a judge.
 */
export const ADVISOR_NOTE_MAX_CHARS = 240;

export function parseAdvisorReply(raw: string): AdvisorNote | null {
  const reply = v.parse(AdvisorReplySchema, extractJsonObject(raw));
  const note = reply.note?.trim();
  if (note === undefined || note.length === 0) return null;
  if (!isAdvisorSeverity(reply.severity)) return null;
  if (!isAdvisorNoteClass(reply.class)) return null;
  return {
    note: note.slice(0, ADVISOR_NOTE_MAX_CHARS),
    severity: reply.severity,
    class: reply.class,
  };
}

/**
 * Review one finished turn.
 *
 * `llm` is the caller's: already routed to the advisor role, already reporting
 * its spend under the `advisor` producer, and already governed by the mission
 * the turn ran under. This function does not know any of that, which is why it
 * can be tested against a two-line fake.
 *
 * Null means no note. Malformed model output is one of the ways that happens
 * and it is recorded by the caller rather than thrown, because an advisory the
 * runtime could not read is not a turn failure — the turn already ended.
 */
export async function reviewCompletedTurn(deps: {
  readonly llm: LLM;
  readonly turn: CompletedTurn;
  /** Capability names the turn actually ran with. See {@link buildAdvisorPrompt}. */
  readonly reachable?: readonly string[];
}): Promise<AdvisorNote | null> {
  const raw = await deps.llm.complete(buildAdvisorPrompt(deps.turn, deps.reachable ?? []));
  return parseAdvisorReply(raw);
}

// ── The lane ────────────────────────────────────────────────────────────────

/**
 * How a note is framed for the agent that reads it.
 *
 * The same precedent as {@link COMPLETION_GATE_HEADER}: a runtime-authored
 * message says so in its own words. The UI cannot be fooled either way — the
 * author stamp is data and the classifier reads it before the bubble branch —
 * but the MODEL only has the prose, and a model that reads an advisory as the
 * user's instruction obeys it instead of weighing it.
 */
export const ADVISOR_HEADER =
  '[Advisor — a second model reviewed the turn you just finished. This is the Kinu '
  + 'runtime, not the user. Weigh it against what you know; it may be wrong.]';

export function advisorSignalText(note: AdvisorNote): string {
  return `${ADVISOR_HEADER}\n\n${ADVISOR_SEVERITY_LABEL[note.severity]}: ${note.note}`;
}

export interface AdvisorLaneDeps {
  /** The turn that just ended. */
  readonly turn: CompletedTurn;
  /** The reviewer's client: routed, metered, and governed by the caller.
   *  Undefined when this backend wires no reviewer, which ends the lane. */
  readonly llm: LLM | undefined;
  /** Whether the owner switched the advisor on. */
  readonly enabled: boolean;
  readonly minSeverity: AdvisorSeverity;
  /** Normalised text of the notes already on the audit stream. */
  readonly recent: readonly string[];
  /** The completion gate has asked its question and not heard back. */
  readonly gateOpen: boolean;
  /** Capability names the turn ran with, so the missed-capability class is
   *  checkable rather than speculative. Empty when the caller cannot say. */
  readonly reachable?: readonly string[];
  /** Speak the note. The caller supplies its own SignalDelivery. */
  readonly deliver: (signal: AgentSignal) => Promise<SignalOutcome>;
  /** Record the note on the audit stream (EvolutionEngine.recordAdvisorNote).
   *  The turn id comes from the lane rather than from each backend's closure:
   *  it is what joins the row back to the conversation it graded, and a backend
   *  that forgot to pass it would write a note no scorer can read while looking
   *  exactly like one that works. */
  readonly record: (note: AdvisorNote, turnId: string | undefined) => void;
}

/**
 * One turn's review, end to end: the ONE turn-end policy, called by every
 * backend that has a turn to review.
 *
 * Shared rather than written per backend because the branch count is what
 * drifts. A cloud actor and a local session that each decided independently
 * whether a `nit` reaches the chat would disagree within a month, and the
 * disagreement would be invisible — both would look like they were working.
 *
 * Never throws and never blocks a turn: the caller fires it detached, and a
 * reviewer that failed is a turn with no advice rather than a failed turn.
 * Answers the disposition it took, or null when there was nothing to say.
 */
export async function runAdvisorLane(deps: AdvisorLaneDeps): Promise<AdvisorDisposition | null> {
  if (!deps.enabled || deps.llm === undefined) return null;
  const note = await reviewCompletedTurn({
    llm: deps.llm, turn: deps.turn, reachable: deps.reachable ?? [],
  });
  if (note === null) return null;
  const verdict = judgeNote({
    note,
    minSeverity: deps.minSeverity,
    recent: deps.recent,
    gateOpen: deps.gateOpen,
  });
  if (verdict.disposition === 'drop') return 'drop';
  // Recorded FIRST, and on both remaining paths. The row is what the next
  // turn's dedupe window reads, so a delivered note that skipped it would be
  // sayable again on the very next turn — which is the nagging this exists to
  // prevent, arriving through the one path that looks like it is working.
  deps.record(note, deps.turn.turnId);
  if (verdict.disposition === 'changelog') return 'changelog';
  const signal: AgentSignal = {
    kind: ADVISOR_SIGNAL_KIND,
    text: advisorSignalText(note),
    severity: note.severity,
    metadata: { [ADVISOR_SEVERITY_METADATA_KEY]: note.severity },
  };
  // Keyed on the FACT: one note per turn, so a re-delivery of the same turn's
  // review collapses onto the row it already opened. Absent on a turn with no
  // durable id, because a fabricated key would collide two different turns.
  const keyed: AgentSignal = deps.turn.turnId === undefined
    ? signal
    : { ...signal, idempotencyKey: `advisor:${deps.turn.turnId}` };
  await deps.deliver(keyed);
  return 'deliver';
}
