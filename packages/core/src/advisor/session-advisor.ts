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
import { attempt, diagnostics, settle } from '../obs/index';
import type { JsonValue } from '../utils/json';
import type { AgentConfigStore } from '../config/store';
import type { KinuExtension } from '../extension';
import type { ActorHandle } from '../identity/actor-handle';
import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';
import type { AgentSignal, SendOutcome } from '../types/signals';
import { isAdvisorSeverity } from '../types/advisor';
import { EVIDENCE_BUDGETS, evidenceWindow, renderToolResult } from '../utils/evidence-window';
import { redactSecrets } from '../safety/secret-patterns';
import type { AdvisorReadTools } from './advisor-ports';
import {
  ADVISOR_NOTE_MAX_CHARS, ADVISOR_RULES, isAdvisorNoteClass, judgeNote, sayAdvisorNote, type AdvisorNote,
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

/** The advisor's own context, cleared past this; the agent's history is never replayed into it. */
const CONVERSATION_MAX_CHARS = 240_000;

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

function readToolNamed(tools: AdvisorReadTools, name: string): Tool | undefined {
  if (name === 'file') return tools.file;

  return name === 'memory' ? tools.memory : undefined;
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

export class SessionAdvisor {
  /** The advisor's own conversation, appended to; never the agent's history again. */
  private conversation: ModelMessage[] = [];
  private conversationChars = 0;
  /** Steps ended and not yet read by a review. */
  private readonly backlog: string[] = [];
  private reviewing: Promise<void> | null = null;
  private turn: AdvisedTurn | null = null;
  private turnRunning = false;
  private step = 0;
  private said = 0;

  constructor(private readonly deps: SessionAdvisorDeps) {}

  get enabled(): boolean {
    return this.deps.config().getAdvisorEnabled();
  }

  /** Off by default: the owner's switch and a reviewed profile decide. */
  get reviewsTurns(): boolean {
    return this.deps.reviewed && this.enabled;
  }

  /** The turn's hooks: it starts, each step's output is read, and its end waits for the last step's review. */
  extension(turn: AdvisedTurn): KinuExtension {
    return {
      name: 'kinu.advisor',
      onTurnStart: (ctx) => {
        this.turn = turn;
        this.turnRunning = true;
        this.step = 0;
        this.said = 0;
        // The request the turn answers: the last of the turn's input, as the agent read it.
        const asked = ctx.history.at(-1);

        if (asked !== undefined && asked.role === 'user') this.read([asked], true);
      },
      onStepEnd: (ctx) => {
        this.step = ctx.stepNumber;
        this.read(ctx.produced, true);
      },
      // The last step was read at its end, and the turn waits for that review. No step follows it, so from here a note
      // is the turn's after it: a nit or a concern is kept unsaid, and a blocker opens the next turn.
      onTurnEnd: async () => {
        this.turnRunning = false;
        await this.settled(this.deps.finalWaitMs ?? FINAL_REVIEW_WAIT_MS);
      },
    };
  }

  /** Once every review owed has run, or `waitMs` has passed. */
  async settled(waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;

    while (this.reviewing !== null && Date.now() < deadline) {
      await Promise.race([this.reviewing, new Promise((resolve) => { setTimeout(resolve, Math.max(0, deadline - Date.now())); })]);
    }
  }

  /** The agent's messages, appended to what the next review reads; a review starts if none runs. */
  private read(messages: readonly ModelMessage[], inProgress: boolean): void {
    if (!this.reviewsTurns || this.turn === null) return;

    for (const message of messages) {
      const rendered = renderForAdvisor(message, inProgress);

      if (rendered !== null) this.backlog.push(rendered);
    }

    if (this.backlog.length > 0 && this.reviewing === null) this.reviewing = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.backlog.length > 0 && this.turn !== null) {
        const delta = this.backlog.splice(0);
        await this.update(this.turn, delta);
      }
    } finally {
      this.reviewing = null;
    }
  }

  /** One review of the steps read since the last: a few calls at most, its notes guarded before any is said. */
  private async update(turn: AdvisedTurn, delta: readonly string[]): Promise<void> {
    // Never the agent's turn's failure: a review that fails is logged, and the next step is read afresh.
    await settle(attempt({ doing: 'reviewing the agent\'s steps', otherwise: 'unavailable' }, async () => {
      if (this.conversationChars > CONVERSATION_MAX_CHARS) [this.conversation, this.conversationChars] = [[], 0];

      for (const text of delta) this.append({ role: 'user', content: text });
      const system = advisorSystemPrompt(turn.reachable, await this.deps.guidance());
      const tools: ToolSet = { ...turn.tools, advise: ADVISE_TOOL };
      const offered = Object.fromEntries(Object.entries(tools).map(([name, offeredTool]) => [name, { ...offeredTool, execute: undefined }]));
      const guards = new UpdateGuards();

      for (let round = 0; round < ROUNDS_PER_UPDATE; round++) {
        const reply = await turn.model({ system, messages: this.conversation, tools: offered });

        for (const message of reply.responseMessages) this.append(message);

        if (reply.toolCalls.length === 0) return;
        const results: { toolCallId: string; toolName: string; text: string }[] = [];
        let stopped = false;

        for (const call of reply.toolCalls) {
          const repeated = guards.repeat(call.toolName, call.input);

          if (repeated === 'stop') {
            stopped = true;
            break;
          }

          let text = 'You made this exact call already; its result has not changed. Decide from what you have.';

          if (repeated === 'ok') {
            text = call.toolName === 'advise' ? await this.advise(turn, call.input, guards) : await this.readTool(readToolNamed(turn.tools, call.toolName), call.input);
          }

          results.push({ toolCallId: call.toolCallId, toolName: call.toolName, text });
        }

        this.append({
          role: 'tool',
          content: results.map((result) => ({ type: 'tool-result', toolCallId: result.toolCallId, toolName: result.toolName, output: { type: 'text', value: result.text } })),
        });

        // A loop past its warning, or an update whose only calls were advice: nothing more to read.
        if (stopped || reply.toolCalls.every((call) => call.toolName === 'advise')) return;
      }
    }).pipe(Effect.catch((failure) => Effect.sync(() => { diagnostics.failure('advisor.review_failed', failure, { actorId: this.deps.actor.actorId }); }))));
  }

  private append(message: ModelMessage): void {
    this.conversation.push(message);
    this.conversationChars += JSON.stringify(message.content).length;
  }

  private async readTool(offered: Tool | undefined, input: JsonValue): Promise<string> {
    if (offered?.execute === undefined) return 'There is no such tool.';
    const result: unknown = await offered.execute(input, { toolCallId: 'advisor', messages: [], context: undefined });

    return shown(renderToolResult(result), MESSAGE_CHARS);
  }

  /** One `advise` call: judged as every note is, recorded, and said where the judgement says. */
  private async advise(turn: AdvisedTurn, input: JsonValue, guards: UpdateGuards): Promise<string> {
    const note = adviseNote(input);

    if (note === null) return 'Not said: a note needs text, a severity of nit, concern or blocker, and a known class.';

    if (note.severity !== 'blocker' && guards.notes >= ADVISOR_NOTES_PER_UPDATE) return 'Not said: enough notes for this step.';
    const config = this.deps.config();
    const notes = this.deps.notes();
    const verdict = judgeNote({ note, minSeverity: config.getAdvisorMinSeverity(), recent: [...notes.recentAdvisorNotes()], gateOpen: this.deps.gateOpen() });

    if (verdict.disposition === 'drop') return 'Not said: it repeats a recent note or says nothing.';

    if (note.severity !== 'blocker') guards.notes += 1;
    const turnId = turn.turnId ?? undefined;
    // After the turn only a blocker opens one: a nit or concern then is a changelog note, kept and visible.
    const spoken = verdict.disposition === 'deliver' && (this.turnRunning || note.severity === 'blocker');

    if (!spoken) {
      notes.recordAdvisorNote(note, turnId, false);

      return 'Recorded, not said.';
    }

    this.said += 1;

    // Said first, then recorded: a note said and not recorded only misses the dedupe window.
    const sent = await sayAdvisorNote(note, {
      turnId, send: this.deps.send, actor: this.deps.actor, key: `${String(this.step)}:${String(this.said)}`,
      ...(this.deps.parent !== undefined && { parent: this.deps.parent }),
    });

    notes.recordAdvisorNote(note, turnId, true);

    if (note.severity === 'blocker' && sent === 'mid-turn' && this.turnRunning) await this.deps.interrupt();

    return sent === 'mid-turn' ? 'Said: the agent reads it at its next step.' : 'Said.';
  }
}
