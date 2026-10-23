/**
 * The advisor in the reviewed agent's own session: it reads the turn as it grows, step by step, in a conversation of
 * its own, and may advise. Ported from oh-my-pi's advisor (packages/coding-agent/src/advisor/runtime.ts): a delta per
 * step, never the history again; one review at a time, later steps batched into the next; read-only tools; an
 * `advise` call that is code-guarded before anything is said. A blocker interrupts the step's foreground calls, as a
 * person's words do; a nit or a concern lands at the next step; after the turn, only a blocker opens one.
 */
import type { ModelMessage, Tool, ToolSet } from 'ai';
import { jsonSchema, tool } from 'ai';
import { Effect } from 'effect';
import * as v from 'valibot';
import { attempt, diagnostics, renderThrownChain, settle, toKinuError, type KinuError } from '../obs/index';
import type { JsonValue } from '../utils/json';
import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from '../identity/actor-handle';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import type { AgentSignal, SendOutcome } from '../types/signals';
import { isAdvisorSeverity } from '../types/advisor';
import { EVIDENCE_BUDGETS, evidenceWindow, renderToolResult } from '../utils/evidence-window';
import { redactSecrets } from '../safety/secret-patterns';
import { fnv1a32Hex } from '../utils/fnv1a';
import { advisorReadTool, type AdvisorReadTools } from './advisor-ports';
import {
  ADVISOR_NOTE_MAX_CHARS, ADVISOR_RULES, isAdvisorNoteClass, judgeNote, normalizeNote, sayAdvisorNote, type AdvisorNote,
} from './review';

/** What one advisor call answers: the calls it made, and its reply as the conversation keeps it. */
export interface AdvisorReply {
  /** Each call's input as the model sent it, read as JSON at the model's boundary. */
  readonly toolCalls: readonly { readonly toolCallId: string; readonly toolName: string; readonly input: JsonValue }[];
  readonly responseMessages: readonly ModelMessage[];
}

/** One call of the advisor's model, its fallbacks walked and its spend filed by the backend that binds it. */
export type AdvisorModel = (request: {
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: ToolSet;
}) => Promise<AdvisorReply>;

/** What a turn hands its advisor: the model on the turn's route, its read-only tools and what it reviews against. */
export interface AdvisedTurn {
  readonly turnId: string | null;
  readonly model: AdvisorModel;
  /** Read-only tools, executed here: never the agent's own instances, whose ledger an advisor read would mark. */
  readonly tools: AdvisorReadTools;
  /** The capabilities the agent can reach this turn, so a missed one can be named. */
  readonly reachable: readonly string[];
}

/** A hosted agent's advisor reads its workspace's switch, floor and guidance, and tells its hirer of a blocker. */
export interface AdvisorContext {
  readonly config: AgentConfigStore;
  readonly workspace: () => Promise<VFS>;
  readonly parent: (signal: AgentSignal) => Promise<SendOutcome>;
}

export interface SessionAdvisorDeps {
  readonly actor: ActorHandle;
  /** The store the owner's switch and floor are read from: the workspace's for a hosted agent. */
  readonly config: () => AgentConfigStore;
  /** The profile's `input`: an agent that takes no input (a swarm node, an evolution agent) is not reviewed. */
  readonly reviewed: boolean;
  readonly notes: () => {
    recentAdvisorNotes(): readonly string[];
    recordAdvisorNote(note: AdvisorNote, turnId?: string, spoken?: boolean): void;
  };
  /** The completion gate has asked and not heard back. */
  readonly gateOpen: () => boolean;
  /** Its own deliveries: a note lands mid-turn, or opens a turn. */
  readonly send: (signal: AgentSignal) => Promise<SendOutcome>;
  /** A hired agent's blocker is also its hirer's. */
  readonly parent?: (signal: AgentSignal) => Promise<SendOutcome>;
  /** Moves the step's foreground calls to the background, as a person's words do; true when that freed the step. */
  readonly interrupt: () => Promise<boolean>;
  /** ADVISOR.md and AGENTS.md as the advisor reads them. */
  readonly guidance: () => Promise<string>;
  /** How long a turn waits at its end for the review of its last step; {@link FINAL_REVIEW_WAIT_MS} unless set. */
  readonly finalWaitMs?: number;
}

/** At most this many notes short of a blocker said per update (oh-my-pi's emission guard: 309 calls in one session). */
const ADVISOR_NOTES_PER_UPDATE = 4;

/** Model calls one update may make: a read, another, then its verdict. */
const ROUNDS_PER_UPDATE = 6;

/** The advisor's own context, at most about this long (one update may pass it): a turn's every step then sends a
 *  request of bounded size, so its cost per step is flat in the turn's length. The agent's history is never replayed. */
const WINDOW_CHARS = 48_000;

/** What a full window keeps, its newest whole exchanges: it is cut in halves, not slid, so between two cuts each request
 *  extends the last and the provider's cached prefix holds. */
const KEPT_CHARS = WINDOW_CHARS / 2;

/** How long a turn waits at its end for the review of its last step. */
const FINAL_REVIEW_WAIT_MS = 120_000;

/** Each message the advisor reads, at most this long, and each tool call's arguments and result. */
const MESSAGE_CHARS = EVIDENCE_BUDGETS.outcomeAssistantResponse;

const CALL_CHARS = EVIDENCE_BUDGETS.patternToolCall;

/** `text` as the advisor's model reads it: its route may be another vendor's, so credentials are redacted before it is
 *  cut, and a cut never leaves a key's body without the header that marks it. */
function shown(text: string, chars: number): string {
  return evidenceWindow(redactSecrets(text), chars);
}

const AdviseSchema = v.object({
  note: v.pipe(v.string(), v.trim(), v.minLength(1)),
  severity: v.string(),
  class: v.string(),
});

const ADVISE_TOOL = tool({
  description: 'Say one thing to the agent you are watching. Silence is the normal answer: call this only for a '
    + 'problem the agent would act on. nit: worth recording, not interrupting for. concern: the agent should weigh it '
    + 'before its next step. blocker: continuing without addressing it wastes the work; it interrupts the agent.',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      note: { type: 'string', description: `At most ${String(ADVISOR_NOTE_MAX_CHARS)} characters: the problem and what to do.` },
      severity: { type: 'string', enum: ['nit', 'concern', 'blocker'] },
      class: { type: 'string', enum: ['wrong-work', 'missed-capability', 'dissatisfaction'] },
    },
    required: ['note', 'severity', 'class'],
    additionalProperties: false,
  }),
});

function advisorSystemPrompt(reachable: readonly string[], guidance: string): string {
  return [
    'You watch an autonomous coding agent work, step by step, and advise it. You see each step as it ends, marked',
    '[in progress] while its turn continues. You have read-only tools to check what you see; you cannot change',
    'anything, run anything, or speak to the person. Your only voice is the `advise` tool.',
    '',
    ...ADVISOR_RULES,
    '',
    reachable.length === 0
      ? 'The agent has no capabilities recorded for this turn.'
      : `The capabilities the agent can reach: ${reachable.join(', ')}`,
    ...(guidance === '' ? [] : ['', '## What this workspace asks its advisor to watch for', '', guidance]),
    '',
    'Silence is the normal answer: most steps are fine. When nothing needs saying, answer with no tool call and no text.',
  ].join('\n');
}

type MessagePart = Exclude<ModelMessage['content'], string>[number];

function renderPart(part: MessagePart): string {
  const record: { readonly type: string } = part;

  switch (record.type) {
    case 'text':
      return v.is(v.object({ text: v.string() }), record) ? shown(record.text, MESSAGE_CHARS) : '';

    case 'tool-call': {
      const call = v.parse(v.looseObject({ toolName: v.string(), input: v.optional(v.unknown()) }), record);

      return `call ${call.toolName}(${shown(JSON.stringify(call.input ?? null), CALL_CHARS)})`;
    }

    case 'tool-result': {
      const result = v.parse(v.looseObject({ toolName: v.string(), output: v.optional(v.unknown()) }), record);
      const output = v.safeParse(v.looseObject({ value: v.unknown() }), result.output);

      return `result ${result.toolName}: ${shown(renderToolResult(output.success ? output.output.value : result.output), CALL_CHARS)}`;
    }

    default:
      // Reasoning, images and files: the advisor judges what was done and said.
      return '';
  }
}

/** One of the agent's messages, as the advisor reads it: its role and what it said or did. */
function renderForAdvisor(message: ModelMessage, inProgress: boolean): string | null {
  const parts = typeof message.content === 'string' ? [shown(message.content, MESSAGE_CHARS)] : message.content.map(renderPart);
  const body = parts.filter((part) => part !== '').join('\n');

  if (body === '') return null;

  return `${inProgress ? '[in progress] ' : ''}${message.role}:\n${body}`;
}

/** One `advise` call's note, or null where it is not one: an unknown or absent severity or class answers nothing, since
 *  a note whose kind is unlabeled is one a judge cannot be told. */
function adviseNote(input: JsonValue): AdvisorNote | null {
  const parsed = v.safeParse(AdviseSchema, input);

  if (!parsed.success || !isAdvisorSeverity(parsed.output.severity) || !isAdvisorNoteClass(parsed.output.class)) return null;

  return { note: parsed.output.note.slice(0, ADVISOR_NOTE_MAX_CHARS), severity: parsed.output.severity, class: parsed.output.class };
}

/** `effect` with a thrown defect (a store's throw, say) worded as its failure, so one catch handles both. */
function worded<A>(doing: string, effect: Effect.Effect<A, KinuError>): Effect.Effect<A, KinuError> {
  return Effect.catchDefect(effect, (cause) => Effect.fail(toKinuError({ doing, otherwise: 'unavailable', cause })));
}

/** A message's length as the window counts it. */
function sizeOf(message: ModelMessage): number {
  return JSON.stringify(message.content).length;
}

/** One advisor update's guards: notes short of a blocker counted, and repeated identical calls. */
class UpdateGuards {
  notes = 0;
  private readonly calls = new Map<string, number>();

  /** `ok` the first time; `warn` on the first repeat; `stop` after. */
  repeat(name: string, input: JsonValue): 'ok' | 'warn' | 'stop' {
    const key = `${name}:${JSON.stringify(input)}`;
    const seen = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, seen);

    if (seen === 1) return 'ok';

    return seen === 2 ? 'warn' : 'stop';
  }
}

/** One turn as its advisor reviews it: what it was handed, whether it still runs, and what it read and has not reviewed.
 *  A review keeps the turn it began on, so one that outlives its turn never speaks for the next. */
interface ReviewedTurn {
  readonly turn: AdvisedTurn;
  running: boolean;
  readonly backlog: string[];
  /** The request the turn answers, as the advisor read it: kept through every cut of the window, as what it judges by. */
  readonly request: string | null;
  /** The owner stopped the turn: its reviews still running say nothing more, as nothing else of a stopped turn does. */
  stopped: boolean;
  /** ADVISOR.md and AGENTS.md, read once a turn: its system prompt is then one through the turn, a cached prefix. */
  guidance: string | null;
}

/** The tool result every call of a stopped update gets: a call left without one fails every later request. */
const STOPPED = 'Stopped: you repeated this call. Decide from what you have.';

export class SessionAdvisor {
  /** The advisor's own conversation, appended to; never the agent's history again. */
  private conversation: ModelMessage[] = [];
  private conversationChars = 0;
  /** The turn whose steps are read now; null before the first. */
  private current: ReviewedTurn | null = null;
  /** Turns with steps read and not yet reviewed, oldest first. */
  private owed: ReviewedTurn[] = [];
  private reviewing: Promise<void> | null = null;

  constructor(private readonly deps: SessionAdvisorDeps) {}

  get enabled(): boolean {
    return this.deps.config().getAdvisorEnabled();
  }

  /** Off by default: the owner's switch and a reviewed profile decide. */
  get reviewsTurns(): boolean {
    return this.deps.reviewed && this.enabled;
  }

  /** A turn starts, answering `asked`, the last of its input as the agent reads it. The session that runs the turn calls
   *  this once, whoever runs its inference: the default loop or the turn's scaffold. */
  beginTurn(turn: AdvisedTurn, asked: ModelMessage | undefined): void {
    // The last turn's steps not yet reviewed are dropped: its model and tools were its own.
    this.endTurn();
    this.owed = [];
    const request = asked?.role === 'user' ? renderForAdvisor(asked, true) : null;
    this.current = { turn, running: true, backlog: [], request, stopped: false, guidance: null };

    if (asked !== undefined && request !== null) this.read([asked]);
  }

  /** One step's own messages, as it ended: a model call of the default loop or of the scaffold's own inference. */
  step(produced: readonly ModelMessage[]): void {
    this.read(produced);
  }

  /** The turn ended, however it ended; `stopped` when the owner stopped it. */
  endTurn(stopped = false): void {
    if (this.current === null) return;
    this.current.running = false;
    this.current.stopped ||= stopped;
  }

  /** The turn answered: its end waits for the review of its last step. No step follows it, so from here a note is the
   *  turn's after it: a nit or a concern is kept unsaid, and a blocker opens the next turn. */
  async finish(): Promise<void> {
    this.endTurn();
    await this.settled(this.deps.finalWaitMs ?? FINAL_REVIEW_WAIT_MS);
  }

  /** Once every review owed has run, or `waitMs` has passed: one timer, cleared, so no wait outlives the call (a pending
   *  timer holds a CLI process open), and no clock read a test may have frozen. */
  async settled(waitMs: number): Promise<void> {
    if (this.reviewing === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => { timer = setTimeout(() => { resolve('expired'); }, waitMs); });

    try {
      while (this.reviewing !== null) {
        const pending: Promise<void> = this.reviewing;

        if (await Promise.race([pending.then(() => 'reviewed' as const), expired]) === 'expired' || this.reviewing === pending) return;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** The agent's messages, appended to what the next review of their turn reads; a review starts if none runs. */
  private read(messages: readonly ModelMessage[]): void {
    const reviewed = this.current;

    if (!this.reviewsTurns || reviewed === null || !reviewed.running) return;

    for (const message of messages) {
      const rendered = renderForAdvisor(message, true);

      if (rendered !== null) reviewed.backlog.push(rendered);
    }

    if (reviewed.backlog.length > 0 && !this.owed.includes(reviewed)) this.owed.push(reviewed);

    if (this.owed.length > 0 && this.reviewing === null) this.reviewing = this.review();
  }

  /** Reviews what was read and not yet reviewed, an update at a time, until nothing is owed. Never fails. */
  review(): Promise<void> {
    return settle(Effect.gen({ self: this }, function* () {
      for (let next = this.owed.shift(); next !== undefined; next = this.owed.shift()) {
        const delta = next.backlog.splice(0);

        if (delta.length > 0) yield* this.update(next, delta);
      }
    }).pipe(Effect.ensuring(Effect.sync(() => {
      this.reviewing = null;

      // A step read as the last update ended is reviewed now, not at the next step's end.
      if (this.owed.length > 0) this.reviewing = this.review();
    }))));
  }

  /** One review of the steps read since the last: a few calls at most, its notes guarded before any is said. A review
   *  that fails is logged, never the agent's turn's failure; the conversation keeps only whole exchanges. */
  private update(reviewed: ReviewedTurn, delta: readonly string[]): Effect.Effect<void> {
    const { turn } = reviewed;

    // A throw anywhere in it, a store's included, is the review's failure: worded, logged, and never the turn's.
    return worded('reviewing the agent\'s steps', Effect.gen({ self: this }, function* () {
      for (const text of delta) this.append({ role: 'user', content: text });
      this.fit(reviewed.request);
      reviewed.guidance ??= yield* attempt({ doing: 'reading the advisor\'s guidance', otherwise: 'unavailable' }, () => this.deps.guidance());
      const system = advisorSystemPrompt(turn.reachable, reviewed.guidance);
      const tools: ToolSet = { ...turn.tools, advise: ADVISE_TOOL };
      const offered = Object.fromEntries(Object.entries(tools).map(([name, offeredTool]) => [name, { ...offeredTool, execute: undefined }]));
      const guards = new UpdateGuards();

      for (let round = 0; round < ROUNDS_PER_UPDATE; round++) {
        const reply = yield* attempt({ doing: 'asking the advisor', otherwise: 'unavailable' }, () => turn.model({ system, messages: this.conversation, tools: offered }));
        const results: { toolCallId: string; toolName: string; text: string }[] = [];
        let stopped = false;

        for (const call of reply.toolCalls) {
          const repeated: 'ok' | 'warn' | 'stop' = stopped ? 'stop' : guards.repeat(call.toolName, call.input);
          stopped = repeated === 'stop';
          let text = repeated === 'stop' ? STOPPED : 'You made this exact call already; its result has not changed. Decide from what you have.';

          if (repeated === 'ok') {
            text = call.toolName === 'advise' ? yield* this.advise(reviewed, call.input, guards) : yield* this.readTool(advisorReadTool(turn.tools, call.toolName), call.input);
          }

          results.push({ toolCallId: call.toolCallId, toolName: call.toolName, text });
        }

        // The reply and its results land together, so a failure between them leaves no call unanswered.
        for (const message of reply.responseMessages) this.append(message);

        if (results.length === 0) return;
        this.append({
          role: 'tool',
          content: results.map((result) => ({ type: 'tool-result', toolCallId: result.toolCallId, toolName: result.toolName, output: { type: 'text', value: result.text } })),
        });

        // A loop past its warning, or an update whose only calls were advice: nothing more to read.
        if (stopped || reply.toolCalls.every((call) => call.toolName === 'advise')) return;
      }
    })).pipe(Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('advisor.review_failed', failure, { actorId: this.deps.actor.actorId }); })));
  }

  private append(message: ModelMessage): void {
    this.conversation.push(message);
    this.conversationChars += sizeOf(message);
  }

  /** Past the window, the oldest exchanges go until {@link KEPT_CHARS} are left, cut before one of the agent's messages so
   *  no tool call loses its result; the turn's `request` is put back first if it went. */
  private fit(request: string | null): void {
    if (this.conversationChars <= WINDOW_CHARS) return;
    let dropped = 0;
    let cut = 0;

    for (const [at, message] of this.conversation.entries()) {
      if (message.role === 'user' && this.conversationChars - dropped <= KEPT_CHARS) break;
      dropped += sizeOf(message);
      cut = at + 1;
    }

    // Never past the newest of the agent's messages: those are what this update reads.
    let newest = 0;

    for (const [at, message] of this.conversation.entries()) if (message.role === 'user') newest = at;
    const kept = this.conversation.slice(Math.min(cut, newest));
    const pinned = request !== null && !kept.some((message) => message.content === request) ? [{ role: 'user' as const, content: request }] : [];

    this.conversation = [...pinned, ...kept];
    this.conversationChars = this.conversation.reduce((total, message) => total + sizeOf(message), 0);
  }

  /** A read's result as the advisor's model reads it; a read that fails is its result, not the review's failure. */
  private readTool(offered: Tool | undefined, input: JsonValue): Effect.Effect<string> {
    if (offered?.execute === undefined) return Effect.succeed('There is no such tool.');

    return attempt({ doing: 'running the advisor\'s read', otherwise: 'unavailable' }, async () => {
      const result: unknown = await offered.execute?.(input, { toolCallId: 'advisor', messages: [], context: undefined });

      return shown(renderToolResult(result), MESSAGE_CHARS);
    }).pipe(Effect.catch((failure) => Effect.succeed(shown(`The read failed: ${renderThrownChain({ cause: failure })}`, MESSAGE_CHARS))));
  }

  /** One `advise` call: judged as every note is, said where the judgement says, then recorded. A failure here, a store's
   *  included, is this call's result, so the round's every call is still answered. */
  private advise(reviewed: ReviewedTurn, input: JsonValue, guards: UpdateGuards): Effect.Effect<string> {
    return worded('judging the advisor\'s note', Effect.suspend(() => this.adviseOnce(reviewed, input, guards)))
      .pipe(Effect.catch((failure) => Effect.succeed(shown(`Not said: ${renderThrownChain({ cause: failure })}`, MESSAGE_CHARS))));
  }

  private adviseOnce(reviewed: ReviewedTurn, input: JsonValue, guards: UpdateGuards): Effect.Effect<string, KinuError> {
    const note = adviseNote(input);

    if (note === null) return Effect.succeed('Not said: a note needs text, a severity of nit, concern or blocker, and a known class.');

    if (note.severity !== 'blocker' && guards.notes >= ADVISOR_NOTES_PER_UPDATE) return Effect.succeed('Not said: enough notes for this step.');
    const config = this.deps.config();
    const notes = this.deps.notes();
    const verdict = judgeNote({ note, minSeverity: config.getAdvisorMinSeverity(), recent: [...notes.recentAdvisorNotes()], gateOpen: this.deps.gateOpen() });

    if (verdict.disposition === 'drop') return Effect.succeed('Not said: it repeats a recent note or says nothing.');

    if (note.severity !== 'blocker') guards.notes += 1;
    const turnId = reviewed.turn.turnId ?? undefined;
    // After the turn only a blocker opens one: a nit or concern then is a changelog note, kept and visible.
    const running = reviewed.running;

    if (verdict.disposition !== 'deliver' || reviewed.stopped || (!running && note.severity !== 'blocker')) {
      notes.recordAdvisorNote(note, turnId, false);

      return Effect.succeed('Recorded, not said.');
    }

    return attempt({ doing: 'saying the advisor\'s note', otherwise: 'unavailable' }, async () => {
      // Keyed on the turn and the note itself, so a restarted turn says a new note and never one it said again.
      const sent = await sayAdvisorNote(note, {
        turnId, send: this.deps.send, actor: this.deps.actor, key: fnv1a32Hex(normalizeNote(note.note)),
        ...(this.deps.parent !== undefined && { parent: this.deps.parent }),
      });

      const said = sent !== 'yielded' && sent !== 'undelivered';
      // Said first, then recorded: a note said and not recorded only misses the dedupe window.
      notes.recordAdvisorNote(note, turnId, said);

      if (!said) return 'Not said: the agent took other words first.';

      // A blocker frees the step from its foreground calls, as a person's words do, while the turn it reviews runs.
      if (note.severity === 'blocker' && reviewed.running) await this.deps.interrupt();

      return running ? 'Said: the agent reads it at its next step.' : 'Said: it opens the agent\'s next turn.';
    });
  }
}
