/**
 * ATTRIBUTION OVER A MULTI-TURN PUBLIC LEDGER: which tool calls belong to which
 * prompt, and which of them proved anything.
 *
 * Extracted from `trajectory.eval.ts` when the second multi-turn family
 * (`kinu-tasks.eval.ts`) needed the same answers. One definition rather than
 * two, for the reason attribution exists at all: a prompt's run is identified
 * by its own `run_start`, by the run it was spliced into when the DO answered
 * `mid-turn`, and by the wake runs of the jobs its calls detached — and a
 * second copy of that walk is a second set of rules about what counts, which
 * is how one family would score a settled recovery the other could not see.
 *
 * NO PLAN IS RESOLVED HERE. Importing a `*.eval.ts` resolves a live target at
 * module scope (`resolvePublicSessionPlan` at the top of every family), so a
 * suite that imported another family's helpers would open that family's
 * banner, skip line and credential decision as a side effect. That is why
 * these live in a plain module both families import instead of being exported
 * from the file that happened to hold them first —
 * `delegation.first-run.ts:251-254` records the same hazard from the other
 * end.
 */
import { posix } from 'node:path';
import * as v from 'valibot';

import { isBackgroundHandle, type JsonValue, type RunEvent } from '../../packages/core/src/index';
import type { KinuPublicSession, PublicMessage } from './public-session';

/** One completed tool call. The only row that carries a call's input, outcome
 *  and identity at once — there is no `tool_call_start`, and nothing has ever
 *  written one (core/src/events/types.ts:147-151). */
export type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

export function isToolCallEnd(event: RunEvent): event is ToolCallEnd {
  return event.type === 'tool_call_end';
}

/** The background jobs a set of runs detached, read off the handles their tool
 *  calls returned. A handle is the only place the prompt's ledger and the job
 *  row meet: the call's `result` carries the `jobId`, and nothing else on
 *  either side does. */
export function detachedJobIds(
  events: readonly RunEvent[], runs: ReadonlySet<string>,
): string[] {
  return [...new Set(events.filter(isToolCallEnd)
    .filter((call) => runs.has(call.runId))
    .map((call) => call.result)
    .filter(isBackgroundHandle)
    .map((handle) => handle.jobId))];
}

/** Identify the requested prompt's run, not a later autonomous run or an
 * earlier run that happens to use the same tool. Missing identity earns no
 * credit. A prompt absorbed mid-turn opens no `run_start` of its own: its run
 * is the one it landed in, read off `absorbedBy` rather than the log.
 *
 * A detached tool call's recovery lands in neither of those: its run's calls
 * end at the background handle, and the job's settle wakes a NEW run whose
 * `run_start.userMessage` is the wake text — never the prompt. The wake run is
 * still the prompt's answer: its `run_start` names the detached job's id
 * verbatim, and the job id is in the handle the prompt's own run returned. So
 * a prompt owns its own runs plus the wake runs of the jobs those runs
 * detached — a recovery that settles past the detach is scorable instead of
 * invisible by construction. */
export function promptToolCalls(
  events: readonly RunEvent[], prompt: string | undefined,
  absorbedBy?: ReadonlyMap<string, string>,
): ToolCallEnd[] {
  if (prompt === undefined) return [];
  const runs = new Set(events.filter((event) => event.type === 'run_start' && event.userMessage === prompt).map((event) => event.runId));
  const absorbed = absorbedBy?.get(prompt);

  if (absorbed !== undefined) runs.add(absorbed);

  for (const jobId of detachedJobIds(events, runs)) {
    for (const event of events) {
      if (event.type === 'run_start' && event.userMessage?.includes(jobId) === true) runs.add(event.runId);
    }
  }

  return events.filter(isToolCallEnd).filter((call) => runs.has(call.runId));
}

/** Missing attribution is a harness evidence gap, not an agent failure or
 * a success inferred from harmless-looking output. The attempt/raw ledger remains retained. */
export function requireMeasuredToolOutcomes(calls: readonly ToolCallEnd[]): void {
  const missing = calls.filter((call) => call.outcome === undefined).length;

  if (missing > 0) throw new Error(`producer tool outcomes unmeasured for ${String(missing)}/${String(calls.length)} observed calls`);
}

const FileActionSchema = v.object({ action: v.string(), path: v.string() });

export function fileActionOn(
  call: ToolCallEnd, action: 'read' | 'write' | 'edit', path: string,
): boolean {
  if (call.name !== 'file' || call.outcome?.success !== true) return false;
  const args = v.safeParse(FileActionSchema, call.args);

  if (!args.success || args.output.action !== action) return false;
  const actual = posix.normalize(args.output.path);

  return actual === path || actual === `/${path}`;
}

const ToolActionSchema = v.object({ action: v.string() });

/** A successful call of a named ACTION on a native tool (`memory` save, `tasks`
 *  list): the file helper above plus the path it needs, for tools whose calls
 *  carry no path. Attribution required — an unmeasured row proves nothing. */
export function toolActionOn(
  call: ToolCallEnd, tool: string, action: string,
): boolean {
  if (call.name !== tool || call.outcome?.success !== true) return false;
  const args = v.safeParse(ToolActionSchema, call.args);

  return args.success && args.output.action === action;
}

const OptionalActionSchema = v.looseObject({ action: v.optional(v.string()) });

/** The action a call named, or `''` when the tool takes none. */
export function actionOf(call: ToolCallEnd): string {
  const parsed = v.safeParse(OptionalActionSchema, call.args);

  return parsed.success ? parsed.output.action ?? '' : '';
}

/** A call ANSWERED: closed with no transport error and no refusal outcome.
 *  `delegation.first-run.ts:110-112`'s rule, which is the one a delegation
 *  subgoal is written against — an unmeasured row is ruled out upstream by
 *  {@link requireMeasuredToolOutcomes} rather than counted as a success here. */
export function ok(call: ToolCallEnd): boolean {
  return call.error === undefined && call.outcome?.success !== false;
}

/** A call's argument or result as the text a reader greps: a JSON string
 *  as-is, anything else re-serialized. The row's own `JsonValue` domain, never
 *  `unknown` — a ledger row is parsed at the route boundary by
 *  `RunEventSchema`, so by the time a predicate reads one the value has a
 *  contract. */
export function textOf(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : JSON.stringify(value);
}

/** A task hire's own answer, off its settled result; null when it never settled with one. */
export function hireAnswer(call: ToolCallEnd): string | null {
  const settled = v.safeParse(SettledHireSchema, call.result);

  return settled.success ? settled.output.answer : null;
}

const SettledHireSchema = v.looseObject({ status: v.literal('completed'), answer: v.string() });

/** Whether `line` relays what a helper `said`, and what it said is `fact`. Words compare without case or
 *  punctuation: a helper answers "Three." as often as "three", and the lead that wrote the fact into the
 *  mission can state it unaided, so only the helper's own recorded words prove a relay. */
export function relaysAnswer(line: string, said: string | null, fact: string): boolean {
  if (said === null || !line.includes('RELAYED')) return false;
  const heard = wordsOf(said);

  return heard.join(' ') === wordsOf(fact).join(' ') && ` ${wordsOf(line).join(' ')} `.includes(` ${heard.join(' ')} `);
}

function wordsOf(text: string): readonly string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The last thing the agent SAID — the durable transcript's final assistant
 *  row, which is what a person reads in the pane. */
export function reply(history: readonly PublicMessage[]): string {
  return history.filter((row) => row.role === 'assistant').at(-1)?.text ?? '';
}

/** The rows the pane renders as SYSTEM CARDS. A delegation digest re-inlined
 *  into the root chat arrives here, which is why the count is a subgoal rather
 *  than a diagnostic. */
export function systemRows(history: readonly PublicMessage[]): readonly PublicMessage[] {
  return history.filter((row) => row.role === 'system');
}

/** The poll cadence the public plane can absorb: the run-event route is paged
 *  REST, and each read is several round trips — anything tighter is load the
 *  episode creates, not evidence it waits for. */
const WAKE_POLL_MS = 250;

/**
 * Wait out the detached jobs a case's prompts minted, until their wake runs
 * close — the product's promise a detached call makes ("the settled result
 * will wake me") measured where it lands.
 *
 * THE BOUND IS THE RUN'S COMPLETION, never a clock (AGENTS.md: no elapsed
 * deadlines on turn work). For each job the prompt's calls detached, a wake
 * run's `run_start` carries the job id verbatim in its `userMessage` — the
 * synthesized "Background run job …" text — so the run to wait on is named
 * rather than guessed. The wait ends per job when every such run has closed;
 * a wake that never opened a run is declared over when the job is settled and
 * no run is still open — either its event was spliced into and consumed by an
 * open turn (which a closed log then rules out), or the delivery failed, in
 * which case the scoring reads the job row the runner wrote before waking.
 *
 * One quiet poll is not proof of quiet: the splice-to-queue hand-off inside
 * the workspace can land a wake's `run_start` a beat after the last `run_end`
 * was read. Two consecutive polls that agree nothing is owed end the wait;
 * the second read costs one page of runs and nothing else.
 */
export async function awaitDetachedJobWakes(
  session: Pick<KinuPublicSession, 'runEvents' | 'backgroundJobs'>,
  turns: readonly string[],
  absorbedBy: ReadonlyMap<string, string>,
): Promise<void> {
  let quiet = 0;

  for (;;) {
    const [jobs, events] = await Promise.all([session.backgroundJobs(), session.runEvents()]);

    const promptRuns = new Set(
      events.filter((event) => event.type === 'run_start' && event.userMessage !== undefined
          && turns.includes(event.userMessage)).map((event) => event.runId),
    );

    for (const runId of absorbedBy.values()) promptRuns.add(runId);

    const detached = detachedJobIds(events, promptRuns);

    if (detached.length === 0) return;

    const openRuns = new Set(
      events.filter((event) => event.type === 'run_start').map((event) => event.runId)
        .filter((runId) => !events.some((event) => event.type === 'run_end' && event.runId === runId)),
    );

    const pending = detached.filter((jobId) => {
      const wakeRuns = events.filter((event) =>
        event.type === 'run_start' && event.userMessage?.includes(jobId) === true).map((event) => event.runId);

      if (wakeRuns.length > 0) return wakeRuns.some((runId) => openRuns.has(runId));

      const job = jobs.find((candidate) => candidate.id === jobId);

      return openRuns.size > 0 || (job !== undefined && job.status === 'running');
    });

    if (pending.length === 0) {
      quiet += 1;

      if (quiet >= 2) return;
    } else {
      quiet = 0;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, WAKE_POLL_MS));
  }
}
