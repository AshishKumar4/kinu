// The advisor: an agent of its own reads a finished turn's record (no tools) and may say one thing about it.
// Stateless: notes, delivery and recording arrive as arguments, so every reviewed actor shares judgeAdvisorReply.

import * as v from 'valibot';
import type { ActorHandle } from '../identity/actor-handle';
import type { EvolutionLaneRequest } from '../identity/evolution-helpers';
import type { AgentSignal, SendOutcome } from '../types/signals';
import type { CompletedTurn, ToolCallRecord } from '../evolution/types';
import { CompletedTurnSchema } from '../evolution/session-window';
import { codemodeProgramOf, codemodeReaches } from '../tools/codemode-reach';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../utils/evidence-window';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../providers/structured';
import { tolerate } from '../obs/index';
import { stableStringify } from '../safety/argument-digest';
import { isJsonObject, type JsonObject, type JsonValue } from '../utils/json';
import { ADVISOR_SEVERITIES, isAdvisorSeverity, type AdvisorSeverity } from '../types/advisor';

export {
  ADVISOR_SEVERITIES, DEFAULT_ADVISOR_MIN_SEVERITY, type AdvisorSeverity,
} from '../types/advisor';

export const ADVISOR_SEVERITY_LABEL = {
  nit: 'Nit',
  concern: 'Concern',
  blocker: 'Blocker',
} as const satisfies Readonly<Record<AdvisorSeverity, string>>;

/** Order matches {@link buildAdvisorPrompt}. `missed-capability` is the signal `turn_ratings` cannot carry:
 *  a capability the turn had and did not use. */
const ADVISOR_NOTE_CLASSES = ['wrong-work', 'missed-capability', 'dissatisfaction'] as const;

export type AdvisorNoteClass = (typeof ADVISOR_NOTE_CLASSES)[number];

function isAdvisorNoteClass<Value>(value: Value): value is Value & AdvisorNoteClass {
  return ADVISOR_NOTE_CLASSES.some((noteClass) => noteClass === value);
}

/** Also what makes the chat render the signal as a card instead of a user bubble. */
export const ADVISOR_SIGNAL_KIND = 'advisor';

export const ADVISOR_SEVERITY_METADATA_KEY = 'advisorSeverity';

/** Written and read back ({@link recentAdvisorNotes}) under one string. */
export const ADVISOR_EVENT_TYPE = 'advisor_note';

export interface AdvisorNote {
  readonly note: string;
  readonly severity: AdvisorSeverity;
  readonly class: AdvisorNoteClass;
}

/** Shared by writer and scorer so a renamed field fails to compile on the other side.
 *  `turnId` is null for a turn with no durable id (programmatic wake); such a note is deduped but scores nothing. */
export const AdvisorRowDataSchema = v.object({
  severity: v.picklist(ADVISOR_SEVERITIES),
  class: v.picklist(ADVISOR_NOTE_CLASSES),
  turnId: v.nullable(v.string()),
  /** Said to the reviewed actor, not only written to the Changelog; a delivery cut short says it again. */
  spoken: v.optional(v.boolean()),
});

export type AdvisorRowData = v.InferOutput<typeof AdvisorRowDataSchema>;

/** The guard is code, not prompt rules: one oh-my-pi session logged 309 `advise` calls, 114 of them "Stop."
 *  (`https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/advisor/emission-guard.ts#L9-L16`). */
export type SuppressionRule = 'duplicate' | 'content-free' | 'gate-open' | 'below-floor';

export type AdvisorDisposition =
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

/** An absent or empty field is the silent answer, which is the expected one. */
const AdvisorReplySchema = v.object({
  note: v.optional(v.string()),
  severity: v.optional(v.string()),
  class: v.optional(v.string()),
});

/** Secrets are redacted before the review prompt: the deep lane may be a different vendor. Shapes mirror
 *  `scripts/secret-scan.ts` (not imported: core cannot depend on scripts); private-key blocks go first. */
const ADVISOR_PRIVATE_KEY_BLOCK = /-----BEGIN[^-]*PRIVATE KEY[^-]*-----[\s\S]*?-----END[^-]*PRIVATE KEY[^-]*-----|-----BEGIN[^-]*PRIVATE KEY[^-]*-----/gu;

const ADVISOR_BEARER_TOKEN = /Bearer\s+[A-Za-z0-9\-._~+/=]{20,}/gu;

const ADVISOR_AWS_ACCESS_KEY = /AKIA[0-9A-Z]{16}/gu;

const ADVISOR_PROVIDER_SECRET = /\b(?:[sr]k_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|sk-ant-[A-Za-z0-9-]{20,}|sk-proj-[A-Za-z0-9_-]{20,})/gu;

const ADVISOR_KINU_TOKEN = /\bp(?:ta|tc|dt)_[0-9a-f]{8,}/gu;

const AdvisorStringSchema = v.string();

function obfuscateAdvisorString(value: string): string {
  return value
    .replace(ADVISOR_PRIVATE_KEY_BLOCK, '[redacted private-key]')
    .replace(ADVISOR_BEARER_TOKEN, '[redacted bearer]')
    .replace(ADVISOR_AWS_ACCESS_KEY, '[redacted api-key]')
    .replace(ADVISOR_PROVIDER_SECRET, '[redacted api-key]')
    .replace(ADVISOR_KINU_TOKEN, '[redacted kinu-token]');
}

/** Rebuilds containers only along paths that changed. */
function obfuscateAdvisorSecrets(value: JsonValue): JsonValue {
  if (v.is(AdvisorStringSchema, value)) return obfuscateAdvisorString(value);

  if (Array.isArray(value)) {
    let changed = false;

    const next = value.map((entry) => {
      const obfuscated = obfuscateAdvisorSecrets(entry);

      if (obfuscated !== entry) changed = true;

      return obfuscated;
    });

    return changed ? next : value;
  }

  if (!isJsonObject(value)) return value;

  let changed = false;
  const next: JsonObject = {};

  for (const [field, fieldValue] of Object.entries(value)) {
    const obfuscated = obfuscateAdvisorSecrets(fieldValue);

    if (obfuscated !== fieldValue) changed = true;

    next[field] = obfuscated;
  }

  return changed ? next : value;
}

/** Arguments and result share the pattern extractor's per-call budget; secrets are obfuscated first. */
function renderToolCall(call: ToolCallRecord): string {
  const args = evidenceWindow(stableStringify(obfuscateAdvisorSecrets(call.args)), EVIDENCE_BUDGETS.patternToolCall);

  const result = call.result === undefined
    ? ''
    : `\n    result: ${evidenceWindow(stableStringify(obfuscateAdvisorSecrets(call.result)), EVIDENCE_BUDGETS.patternToolCall)}`;

  const outcome = call.outcome === undefined ? 'unmeasured' : stableStringify(call.outcome);

  return `  - ${call.name}(${args}) outcome=${outcome}${result}`;
}

/** Silence is the stated default: a reviewer asked to review always finds something. Negative space ported from
 *  https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/prompts/advisor/system.md.
 *  `reachable` makes missed-capability checkable; a capability reached through codemode counts as used. */
export function buildAdvisorPrompt(
  turn: CompletedTurn, reachable: readonly string[] = [], guidance = '',
): string {
  const tools = turn.toolCalls.length === 0
    ? '  (none)'
    : turn.toolCalls.map(renderToolCall).join('\n');

  const called = new Set(turn.toolCalls.map((call) => call.name));

  const programs = turn.toolCalls
    .map((call) => codemodeProgramOf(call.name, call.args))
    .filter((program) => program !== '');

  const unused = reachable.filter((name) => !called.has(name)
    && !programs.some((program) => codemodeReaches(program, name)));

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
    '  capability and the moment it should have been used. Only from the reachable list below:',
    '  if the capability is not on that list the agent did not have it, and there is nothing to say.',
    '- "dissatisfaction": visible dissatisfaction from the user in this turn: explicit',
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
    'UNKNOWN: never assert a value the record does not show. Do not guess at what is not there, and',
    'do not ask for reassurance.',
    '',
    'Silence is the normal answer. Most turns are fine.',
    ...(guidance === '' ? [] : ['', '## What this workspace asks its advisor to watch for', '', guidance]),
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
    '  e.g. "The three sequential writes to the same module could have been one edit. Nothing to redo: worth knowing next time."',
    '- "concern": the agent should weigh this before its next step.',
    '  e.g. "The recorded run outcome failed with execution.exitCode 3, but you treated it as successful. Fix the command failure before relying on its result."',
    '- "blocker": continuing without addressing this wastes the work.',
    '  e.g. "The migration ran against the live database before the suite ran once. Stop and confirm a backup exists before continuing."',
    '',
    `One note, at most ${String(ADVISOR_NOTE_MAX_CHARS)} characters, addressed to the agent. State the problem and what`,
    'to do. No preamble, no praise, no restating the turn.',
    '',
    'JSON shape when you have something: {"note":"<the note>","severity":"nit"|"concern"|"blocker",'
      + '"class":"wrong-work"|"missed-capability"|"dissatisfaction"}',
    'JSON shape when you do not: {}',
    jsonObjectOnlyInstruction(),
  ].join('\n');
}

/** Over-long notes are truncated, not rejected; an unknown severity or class is a contract failure (null). */
export const ADVISOR_NOTE_MAX_CHARS = 240;

export function parseAdvisorReply(raw: string): AdvisorNote | null {
  const extracted = tolerate(() => extractJsonObject(raw), 'malformed-input');

  if (extracted === undefined) return null;
  const parsed = v.safeParse(AdvisorReplySchema, extracted);

  if (!parsed.success) return null;
  const reply = parsed.output;
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

/** The preset the advisor is hired under (profiles/catalog.ts `SYSTEM_ROLE_DEFINITIONS`). */
export const ADVISOR_ROLE_ID = 'advisor';

const ADVISOR_LANE_PREFIX = 'advisor:';

/** The reviewed turn's lane on the reviewing actor's helper rows; the answer finds its turn by it. */
export function advisorLane(turnId: string): EvolutionLaneRequest {
  return { requestId: `${ADVISOR_LANE_PREFIX}${turnId}` };
}

/** The turn an answered helper lane reviewed, or null for another lane's helper (a refiner). */
export function advisedTurnOf(lane: EvolutionLaneRequest): string | null {
  return lane.requestId.startsWith(ADVISOR_LANE_PREFIX) ? lane.requestId.slice(ADVISOR_LANE_PREFIX.length) : null;
}

/** A runtime-authored message says so (as {@link COMPLETION_GATE_HEADER}): the model only has the prose, and would
 *  obey an advisory it read as the user's instruction. */
export const ADVISOR_HEADER =
  '[Advisor: a second model reviewed the turn you just finished. This is the Kinu '
  + 'runtime, not the user. Weigh it against what you know; it may be wrong.]';

function advisorSignalText(note: AdvisorNote): string {
  return `${ADVISOR_HEADER}\n\n${ADVISOR_SEVERITY_LABEL[note.severity]}: ${note.note}`;
}

/** What the advisor is hired on; recorded at the turn's end, so a replay reads the tool surface that turn had.
 *  The note is judged when the answer arrives, against the floor and dedupe window of that moment. */
export const AdvisorRecoverySnapshotSchema = v.object({
  turn: CompletedTurnSchema,
  reachable: v.array(v.string()),
  model: v.optional(v.string()),
});

export type AdvisorRecoverySnapshot = v.InferOutput<typeof AdvisorRecoverySnapshotSchema>;

/**
 * The one judgement every reviewed actor's advisor answer takes, recorded when kept: `changelog` is filed only,
 * `deliver` is also to be said ({@link sayAdvisorNote}). Null when it said nothing readable.
 */
export function judgeAdvisorReply(reply: string, deps: {
  readonly turnId: string | undefined;
  readonly minSeverity: AdvisorSeverity;
  /** Normalised text of the notes already on the audit stream. */
  readonly recent: readonly string[];
  /** The completion gate has asked its question and not heard back. */
  readonly gateOpen: boolean;
  /** The turn id joins the row to the conversation it graded; `spoken` when the note is said, not only filed. */
  readonly record: (note: AdvisorNote, turnId: string | undefined, spoken: boolean) => void;
}): { readonly note: AdvisorNote; readonly disposition: AdvisorDisposition } | null {
  const note = parseAdvisorReply(reply);

  if (note === null) return null;
  const { disposition } = judgeNote({ note, minSeverity: deps.minSeverity, recent: deps.recent, gateOpen: deps.gateOpen });

  // Recorded before it is said: the row feeds the next turn's dedupe window.
  if (disposition !== 'drop') deps.record(note, deps.turnId, disposition === 'deliver');

  return { note, disposition };
}

/**
 * A recorded note said to the reviewed actor, and a blocker to its parent too. Keyed on the turn, so a note said
 * again after a cut delivery collapses onto the turn it already opened; no key without a durable id.
 */
export async function sayAdvisorNote(note: AdvisorNote, deps: {
  readonly turnId: string | undefined;
  readonly send: (signal: AgentSignal) => Promise<SendOutcome>;
  readonly actor?: ActorHandle;
  readonly parent?: (signal: AgentSignal) => Promise<SendOutcome>;
}): Promise<SendOutcome> {
  const signal: AgentSignal = {
    kind: ADVISOR_SIGNAL_KIND,
    text: advisorSignalText(note),
    severity: note.severity,
    metadata: { [ADVISOR_SEVERITY_METADATA_KEY]: note.severity },
  };

  const keyed: AgentSignal = deps.turnId === undefined || deps.turnId === ''
    ? signal
    : { ...signal, idempotencyKey: deps.actor === undefined
      ? `advisor:${deps.turnId}` : `advisor:${deps.actor.actorId}:${deps.turnId}` };

  const sent = await deps.send(keyed);

  if (note.severity === 'blocker' && deps.actor !== undefined && deps.parent !== undefined) {
    await deps.parent({ ...keyed, text: `[Actor ${deps.actor.name}]\n${keyed.text}` });
  }

  return sent;
}
