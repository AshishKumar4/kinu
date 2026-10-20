/**
 * The owner's own coding sessions (OMP's session logs) as the turns Kinu records: each owner message, the work that
 * answered it, and the owner's next message on the same branch, which is how that work was received
 * (docs/omp-measurement design; /mnt/local/kinu/tmp/omp-measurement-design.md).
 *
 * A log is a tree: every entry names its parent, so a turn is an owner message and the entries that descend from it
 * until the next owner message. A fork copies its parent's entries under fresh ids with their timestamps kept, so a
 * turn is one turn wherever it was copied: an owner message is its text and its timestamp. Every text kept passes the
 * one secret policy (`redactSecrets`, through `compactToolCall` for calls).
 */
import * as v from 'valibot';
import { CompletedTurnSchema, JsonValueSchema, redactSecrets, type JsonObject, type JsonValue } from '../../packages/core/src/index';
import { compactToolCall } from '../../packages/core/src/evolution/tool-call-record';

const TextBlock = v.object({ type: v.literal('text'), text: v.string() });

const ToolCallBlock = v.object({ type: v.literal('toolCall'), id: v.string(), name: v.string(), arguments: v.optional(v.record(v.string(), JsonValueSchema)) });

const Block = v.union([TextBlock, ToolCallBlock, v.object({ type: v.string() })]);

const Entry = v.object({ id: v.string(), parentId: v.nullish(v.string()), timestamp: v.string() });

const MessageEntry = v.object({
  ...Entry.entries,
  type: v.literal('message'),
  message: v.variant('role', [
    v.object({ role: v.literal('user'), content: v.union([v.string(), v.array(Block)]) }),
    v.object({ role: v.literal('assistant'), content: v.array(Block) }),
    v.object({ role: v.literal('toolResult'), toolCallId: v.string(), content: v.array(Block), isError: v.optional(v.boolean()) }),
    v.object({ role: v.string() }),
  ]),
});

/** One line of a session log: a message, or any other entry, which carries its place in the tree and nothing kept. */
const LogLine = v.union([MessageEntry, v.object({ ...Entry.entries, type: v.string() })]);

export type LogLine = v.InferOutput<typeof LogLine>;

const LogText = v.pipe(v.string(), v.parseJson(), LogLine);

/** A log line's entry; null for a line that is no entry (the session header, a torn write). */
export function parseLogLine(text: string): LogLine | null {
  const parsed = v.safeParse(LogText, text);

  return parsed.success ? parsed.output : null;
}

/** An owner turn as the converter keeps it: the recorded turn, when it was asked, and how the owner answered it. */
export const OwnerTurnSchema = v.object({
  turn: CompletedTurnSchema,
  at: v.string(),
  /** The owner's next message on the same branch; null when the session ended there. */
  followup: v.nullable(v.object({ text: v.string(), at: v.string() })),
});

export type OwnerTurn = v.InferOutput<typeof OwnerTurnSchema>;

/** A dataset file the converter wrote: one owner turn per line. */
export function ownerTurnsFrom(jsonl: string): OwnerTurn[] {
  return jsonl.split('\n').filter((row) => row.trim() !== '').map((row) => v.parse(v.pipe(v.string(), v.parseJson(), OwnerTurnSchema), row));
}

/** A text the harness shook out of its context to save room, and where its bytes went. */
const SHAKEN = /\[shaken ~\d+ tokens — recover: artifact:\/\/(\d+) \(region (\d+)\)\]/gu;

/** The note a harness leaves in an assistant's text for a call whose arguments it dropped: `[tool:<name>] <summary>`. */
const CALL_NOTE = /^\[tool:[\w.-]+\]/u;

/** A shaken artifact's regions by number: `### region <n> (<tool>, ~<k> tok)` and the lines up to the next. */
export function shakenRegions(log: string): Map<number, string> {
  const regions = new Map<number, string>();
  const parts = log.split(/^### region (\d+) \([^)\n]*\)$/mu);

  for (let at = 1; at + 1 < parts.length; at += 2) regions.set(Number(parts[at]), (parts[at + 1] ?? '').replace(/^\n+|\n+$/gu, ''));

  return regions;
}

/** Each shaken text put back from its artifact's region, where `artifact` has it; otherwise left as it was. */
export function unshaken(text: string, artifact: (id: number) => ReadonlyMap<number, string> | null): string {
  return text.replaceAll(SHAKEN, (shaken, id: string, region: string) => artifact(Number(id))?.get(Number(region)) ?? shaken);
}

function textOf(content: string | readonly v.InferOutput<typeof Block>[], prose = false): string {
  if (typeof content === 'string') return content;

  return content.flatMap((block) => (v.is(TextBlock, block) && !(prose && CALL_NOTE.test(block.text)) ? [block.text] : [])).join('\n');
}

interface Building {
  readonly key: string;
  readonly id: string;
  readonly session: string;
  readonly at: string;
  readonly request: string;
  answer: string;
  steps: number;
  last: string;
  hadError: boolean;
  readonly calls: Map<string, { name: string; args: JsonObject; result?: JsonValue; failed?: boolean }>;
  followup: { readonly text: string; readonly at: string } | null;
}

/**
 * Turns from session logs read in order, each entry once. `add` takes one parsed log line of `session`; `turns` yields
 * every owner turn seen, each once, in the order it was asked.
 */
export class OwnerTurns {
  /** `artifact` reads a session's shaken artifact, by number, as `shakenRegions` parses it; absent, nothing is put back. */
  constructor(private readonly artifact: (session: string, id: number) => ReadonlyMap<number, string> | null = () => null) {}

  /** Each entry's owner turn: the text-and-time key of the owner message it descends from. */
  private readonly turnOf = new Map<string, string>();
  private readonly building = new Map<string, Building>();
  /** Owner messages, by text and time, already taken from an earlier copy. */
  private readonly copied = new Set<string>();
  /** Entries of a turn already taken from an earlier copy: their work is that copy's. */
  private readonly skipped = new Set<string>();
  private readonly counts = { records: 0, ownerRecords: 0, forkCopies: 0, unparsed: 0 };

  add(session: string, line: LogLine | null): void {
    this.counts.records += 1;

    if (line === null) {
      this.counts.unparsed += 1;

      return;
    }

    if (!v.is(MessageEntry, line)) {
      // Every entry carries the turn it descends from on, messages or not.
      this.inherit(line.id, line.parentId);

      return;
    }

    const { id, parentId, timestamp, message } = line;

    if (message.role === 'user' && 'content' in message) {
      this.counts.ownerRecords += 1;
      this.owner(session, { id, parentId, at: timestamp, text: this.recovered(session, textOf(message.content)) });

      return;
    }

    const key = this.inherit(id, parentId);
    const turn = key === undefined || this.skipped.has(key) ? undefined : this.building.get(key);

    if (turn === undefined) return;
    turn.last = timestamp;

    if (message.role === 'assistant' && 'content' in message && Array.isArray(message.content)) {
      turn.steps += 1;
      // A call's note stands in for its dropped arguments; it is no part of the answer.
      const text = this.recovered(session, textOf(message.content, true));

      if (text.trim() !== '') turn.answer = text;

      for (const [at, block] of message.content.entries()) {
        if (!v.is(ToolCallBlock, block)) continue;
        const note = message.content[at + 1];
        const dropped = Object.keys(block.arguments ?? {}).length === 0 && v.is(TextBlock, note) && CALL_NOTE.test(note.text);

        turn.calls.set(block.id, { name: block.name, args: dropped ? { note: this.recovered(session, note.text) } : (block.arguments ?? {}) });
      }
    }

    if (message.role === 'toolResult' && 'toolCallId' in message) {
      const call = turn.calls.get(message.toolCallId);

      if (call === undefined) return;
      call.result = this.recovered(session, textOf(message.content));
      call.failed = message.isError === true;
      turn.hadError ||= call.failed;
    }
  }

  private recovered(session: string, text: string): string {
    return text.includes('[shaken ~') ? unshaken(text, (id) => this.artifact(session, id)) : text;
  }

  private inherit(id: string, parentId: string | null | undefined): string | undefined {
    const key = parentId === null || parentId === undefined ? undefined : this.turnOf.get(parentId);

    if (key !== undefined) this.turnOf.set(id, key);

    return key;
  }

  private owner(session: string, { id, parentId, at, text }: { readonly id: string; readonly parentId: string | null | undefined; readonly at: string; readonly text: string }): void {
    const key = JSON.stringify([text, at]);
    const asked = parentId === null || parentId === undefined ? undefined : this.turnOf.get(parentId);
    this.turnOf.set(id, key);

    // The turn it answers was received by this message; a fork that runs on past where the first copy ended answers it too.
    const answered = asked === undefined ? undefined : this.building.get(asked);

    if (answered !== undefined && answered.followup === null) answered.followup = { text: redactSecrets(text), at };

    if (this.copied.has(key)) {
      this.counts.forkCopies += 1;
      this.skipped.add(key);

      return;
    }

    this.copied.add(key);
    this.building.set(key, {
      key, id, session, at, request: redactSecrets(text), answer: '', steps: 0, last: at, hadError: false, calls: new Map(), followup: null,
    });
  }

  /** Each owner turn once, in the order it was asked. */
  turns(): OwnerTurn[] {
    return [...this.building.values()].sort((a, b) => a.at.localeCompare(b.at)).map((built) => ({
      at: built.at,
      followup: built.followup,
      turn: {
        userMessage: built.request,
        assistantResponse: redactSecrets(built.answer),
        toolCalls: [...built.calls.entries()].map(([toolCallId, call]) => compactToolCall({
          toolCallId, name: call.name, args: call.args,
          ...(call.result !== undefined && { result: call.result }),
          ...(call.failed !== undefined && { outcome: call.failed ? { success: false, reason: null } : { success: true } }),
        })),
        steps: built.steps,
        durationMs: Math.max(0, Date.parse(built.last) - Date.parse(built.at)),
        feedback: null,
        hadError: built.hadError,
        turnId: built.id,
        sessionId: built.session,
        origin: 'user',
      },
    }));
  }

  /** What was read: log records, owner records, owner records that were a fork's copy, and lines no entry parsed from. */
  read(): Readonly<typeof this.counts> {
    return { ...this.counts };
  }
}

export interface OwnerSplit {
  readonly train: OwnerTurn[];
  readonly heldOut: OwnerTurn[];
}

/** Turns asked before `cutoff` train; from it on, they are held out. */
export function splitAt(turns: readonly OwnerTurn[], cutoff: string): OwnerSplit {
  return { train: turns.filter((turn) => turn.at < cutoff), heldOut: turns.filter((turn) => turn.at >= cutoff) };
}
