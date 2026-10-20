/**
 * Each finished phase of an answer's tool calls named in a few words by the account's fast tier (the owner,
 * 2026-10-19), written into the answer's metadata. Asked once a tab shows a settled answer whose phases have no line, so
 * it is never part of the turn that answered: no turn waits on it, and an answer nobody opens costs nothing. Until a line
 * lands, and wherever none does, the chat shows the line the calls make (`read-models/tool-phase-title.ts`). A call that
 * fails or is refused ends the writing there, so the lines never compete with the account's turns for its limits.
 */
import type { UIMessage } from 'ai';
import * as v from 'valibot';
import { Effect } from 'effect';
import { diagnostics, toKinuError, tolerate, type KinuError } from '../obs/index';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../providers/structured';
import { groupMessageParts, partInput, partOutput, phaseCalls, type AnyToolPart, type PartBlock } from '../read-models/tool-call-grouping';
import { PHASE_TITLES_METADATA_KEY, TURN_TITLE_METADATA_KEY, writtenTitles } from '../read-models/tool-phase-title';
import type { JsonObject } from '../utils/json';

type Part = UIMessage['parts'][number];

const PHASE_LINE_SYSTEM_PROMPT = "You name what a phase of an agent's work did, for one line in a chat.";

/** A call's result as the line's model reads it: enough to tell what it found, never a whole file. */
const RESULT_CHARS = 240;

/** The phases an answer holds before its whole turn is named too: a turn the chat rolls up. */
const TURN_PHASES = 3;

const clip = (text: string): string => (text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}...` : text);

function callLine(part: AnyToolPart, at: number): string {
  const result = part.state === 'output-error' ? `failed: ${part.errorText}` : JSON.stringify(partOutput(part) ?? null);

  return `${String(at + 1)}. ${part.type.replace(/^tool-/u, '')} ${JSON.stringify(partInput(part) ?? {})} -> ${clip(result)}`;
}

const thoughtsOf = (block: PartBlock | undefined): string[] => (block?.kind === 'reasoning' ? block.parts.map((part) => part.text) : []);

/** What the model is shown of one phase: what was asked, the thinking that opened it, its calls, and the thinking in and after it. */
function phaseLinePrompt(ask: string, blocks: readonly PartBlock[], at: number): string {
  const block = blocks[at];
  const steps = block?.kind === 'run' ? block.steps : [];
  const before = thoughtsOf(blocks[at - 1]);
  const during = [...steps.flatMap((step) => (step.kind === 'reasoning' ? step.parts.map((part) => part.text) : [])), ...thoughtsOf(blocks[at + 1])];

  return [
    "Name this phase of an agent's work in 2 to 6 words, past tense, the way a commit subject names a change: what it did or",
    'found, never which tools it used. Examples: "Found the renamed D1 binding", "Fixed and tested the Worker".',
    jsonObjectOnlyInstruction(), 'Its key: "title".', '',
    `The owner asked: ${ask}`, '',
    ...(before.length === 0 ? [] : ['Thinking before the phase:', ...before, '']),
    "The phase's calls, in order:", ...phaseCalls(steps).map(callLine), '',
    ...(during.length === 0 ? [] : ['Thinking during and after it:', ...during]),
  ].join('\n');
}

function turnLinePrompt(ask: string, lines: readonly string[]): string {
  return [
    "Name what this whole turn of an agent's work did in 3 to 7 words, past tense, like a commit subject.",
    jsonObjectOnlyInstruction(), 'Its key: "title".', '',
    `The owner asked: ${ask}`, '', 'Its phases, in order:', ...lines.map((line, at) => `${String(at + 1)}. ${line}`),
  ].join('\n');
}

const LineSchema = v.object({ title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)) });

/** The line a model wrote, without a closing full stop; null when it wrote none. */
function parseLine(raw: string): string | null {
  const parsed = v.safeParse(LineSchema, tolerate(() => extractJsonObject(raw), 'malformed-input'));

  return parsed.success ? parsed.output.title.replace(/\.$/u, '') : null;
}

/** What the writer reads of an answer and writes back, each backend's own. */
export interface PhaseLinePorts {
  /** The answer as the chat draws it, and the words that asked for it; null for an id that names no answer. */
  answer(messageId: string): Promise<{ readonly parts: readonly Part[]; readonly metadata: unknown; readonly ask: string } | null>;
  /** Completions on the `phase_line` route, the account's fast tier: resolved once, and only once a line is wanted. */
  completer(): Promise<(system: string, prompt: string) => Promise<string>>;
  /** Merges `patch` into the answer's metadata, and shows its chat the answer again. */
  amend(messageId: string, patch: JsonObject): Promise<void>;
}

type Complete = (system: string, prompt: string) => Promise<string>;

/** A line the fast tier wrote (null when it wrote none), or the failure that ends the writing. */
type Answered = { readonly line: string | null } | { readonly failed: KinuError };

/** One line from the fast tier; a failure is said once in the log and answered as the writing's end. */
function lineOf(complete: () => Promise<Complete>, prompt: string, messageId: string): Effect.Effect<Answered> {
  return Effect.tryPromise({
    try: async () => parseLine(await (await complete())(PHASE_LINE_SYSTEM_PROMPT, prompt)),
    catch: (cause) => toKinuError({ doing: 'writing a phase line on the fast tier', cause, otherwise: 'unavailable' }),
  }).pipe(
    Effect.map((line): Answered => ({ line })),
    Effect.catch((error) => Effect.sync((): Answered => {
      diagnostics.failure('chat.phase_line_failed', error, { messageId });

      return { failed: error };
    })),
  );
}

/** The lines the answer still lacks, in order, and its turn's, written while the fast tier answers; a failed call ends
 *  the writing, and what was written before it is kept. */
function writeLines(ports: PhaseLinePorts, messageId: string, answer: { readonly parts: readonly Part[]; readonly metadata: unknown; readonly ask: string }) {
  let resolved: Promise<Complete> | null = null;
  const complete = (): Promise<Complete> => (resolved ??= ports.completer());

  return Effect.gen(function* () {
    const blocks = groupMessageParts(answer.parts);
    const written = writtenTitles({ metadata: answer.metadata });
    const lines = new Map(written.phases);

    const phases = blocks.flatMap((block, at) => {
      const [first] = block.kind === 'run' ? phaseCalls(block.steps) : [];

      return first === undefined ? [] : [{ first: first.toolCallId, at }];
    });

    let failed = false;

    for (const { first, at } of phases) {
      if (lines.has(first)) continue;
      const answered = yield* lineOf(complete, phaseLinePrompt(answer.ask, blocks, at), messageId);

      if ('failed' in answered) {
        failed = true;
        break;
      }

      if (answered.line !== null) lines.set(first, answered.line);
    }

    const named = phases.flatMap(({ first }) => lines.get(first) ?? []);
    const asksTurn = !failed && written.turn === null && phases.length >= TURN_PHASES && named.length === phases.length;
    const turnAnswered = asksTurn ? yield* lineOf(complete, turnLinePrompt(answer.ask, named), messageId) : null;
    const turn = turnAnswered !== null && 'line' in turnAnswered ? turnAnswered.line : written.turn;

    return { phases: Object.fromEntries(lines), turn, failed, any: phases.length > 0, wrote: lines.size > written.phases.size || turn !== written.turn };
  });
}

/** The answer's phases named, those still unnamed, and stamped on it; what it did, in words for the log, or null when
 *  no committed answer has the id (its turn may still be running). */
export function writePhaseLines(ports: PhaseLinePorts, messageId: string): Effect.Effect<string | null, KinuError> {
  return Effect.gen(function* () {
    const answer = yield* Effect.tryPromise({
      try: async () => await ports.answer(messageId),
      catch: (cause) => toKinuError({ doing: 'reading the answer its phase lines are for', cause, otherwise: 'unavailable' }),
    });

    if (answer === null) return null;
    const outcome = yield* writeLines(ports, messageId, answer);

    if (!outcome.any) return 'no phase to name';

    if (!outcome.wrote) return outcome.failed ? 'the fast tier did not answer' : 'nothing left to name';
    const patch: JsonObject = { [PHASE_TITLES_METADATA_KEY]: outcome.phases };

    if (outcome.turn !== null) patch[TURN_TITLE_METADATA_KEY] = outcome.turn;
    yield* Effect.tryPromise({
      try: async () => { await ports.amend(messageId, patch); },
      catch: (cause) => toKinuError({ doing: "stamping an answer's phase lines on it", cause, otherwise: 'unavailable' }),
    });

    return outcome.failed ? 'named some; the fast tier did not answer the rest' : 'named';
  });
}
