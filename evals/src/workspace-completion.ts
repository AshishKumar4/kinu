import { silenceBoundMs, type RunEvent } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import type { KinuPublicSession, PublicBackgroundJob, PublicMessage, PublicSubordinate } from './session';

/** How often an unsettled workspace is looked at. A poll, not a deadline: only a hang or the trial's budget ends a turn
 *  here. A poll reads only what the ledger added since the last one, so a short interval costs the deployment little. */
const IDLE_POLL_MS = 1_000;

/** How often the workspace is looked at while the turn's own stream is open, for a hang alone. Each look reads every
 *  run's new rows over HTTP: once a second for 180 trials at once is hundreds of requests a second at the build. */
const STREAMING_POLL_MS = 30_000;

/** Polls in a row the deployment's transport may fail before the trial fails as infrastructure. */
const DROPPED_POLLS = 3;

/** How often a working helper's own jobs are read: at every poll, each helper would multiply the build's reads, and a
 *  job is judged by whether it settled, which half a minute's age does not change against a bound of minutes. */
const HELPER_JOBS_MS = 30_000;

/** How often a trial says which jobs it waits on: a job publishes nothing while it runs, and the deploy ends a run that
 *  writes nothing for 480 s (`GATE_DEADLINE_SECONDS`). */
const WAITING_LINE_MS = 60_000;

/**
 * How long a busy workspace may say nothing (no ledger row, no byte in any room it relays, no tool call in flight, no
 * provider wait declared) before its turn fails as a product hang. A provider that sends nothing for its own bound
 * fails the call and writes the failed `model_operation` row (`provider.stream.idle_ms`), and a minute more, which
 * outlasts a 30 s look while a turn streams, lets that row land first: a provider's stall is its failure, never a
 * product hang. Inside the deploy's 480 s silence bound (`GATE_DEADLINE_SECONDS`), so a hung trial says so first.
 */
export const HUNG_AFTER_MS = silenceBoundMs('provider.stream.idle_ms') + 60_000;

/** The time a watch reads and the waits between its looks, which `stop` ends early: the wall clock, or a test's own. */
export type WatchClock = { now(): number; sleep(ms: number, stop?: AbortSignal): Promise<void> };

const WALL_CLOCK: WatchClock = {
  now: () => Date.now(),
  sleep: (ms, stop) => new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      stop?.removeEventListener('abort', wake);
      resolve();
    };

    const timer = setTimeout(wake, ms);

    stop?.addEventListener('abort', wake, { once: true });
  }),
};

/** What a watch reads of a workspace, and the helpers' rooms it asks to hear. */
export type WatchedWorkspace = Pick<KinuPublicSession, 'runEvents' | 'backgroundJobs' | 'subordinates' | 'toolCallsInFlight' | 'heard' | 'listen'>;

/** A trial's budget (`budget.ts`): past `ms` after `startedAt`, a turn still held fails over budget. */
export type TrialBudget = { readonly task: string; readonly ms: number; readonly startedAt: number };

/** How a turn is watched: its clock, its trial's budget (none for a workspace that is no trial's), and where to say, once
 *  a minute, which jobs it waits on. */
export type WatchOptions = { readonly clock?: WatchClock; readonly budget?: TrialBudget; readonly waiting?: (line: string) => void };

/**
 * What a watch ended a turn on: `outcome`, the message naming what held the workspace, and `heldBy`, the kinds of what
 * held it (`open run`, `working helper`, `running shell job`), which the report counts the failure under.
 */
export abstract class WorkspaceHeld extends Error {
  abstract readonly outcome: 'hung' | 'over-budget';

  constructor(message: string, readonly heldBy: readonly string[]) {
    super(message);
  }
}

/**
 * A turn whose workspace stayed busy and silent past the bound, held by a run or a helper: the build hung. A job is never
 * silent, only unfinished: it publishes nothing while it runs, so it is waited on until it settles or the budget ends.
 */
export class WorkspaceHang extends WorkspaceHeld {
  override readonly name = 'WorkspaceHang';

  override readonly outcome = 'hung';
}

/** A trial that ran past its task's budget, whatever held it: a job that never settles, a run that never stops. */
export class TrialOverBudget extends WorkspaceHeld {
  override readonly name = 'TrialOverBudget';

  override readonly outcome = 'over-budget';
}

/** A job the workspace waits on: the lead's, or one of a helper waiting on its own. */
type HeldJob = { readonly job: PublicBackgroundJob; readonly helper: string | null };

/** What holds a workspace busy: its open runs, the helpers that stream, and the jobs it waits on. */
type Holders = { readonly runs: readonly string[]; readonly helpers: readonly PublicSubordinate[]; readonly jobs: readonly HeldJob[] };

function openRuns(events: readonly RunEvent[]): string[] {
  const ended = new Set(events.filter((event) => event.type === 'run_end').map((event) => event.runId));

  return events.filter((event) => event.type === 'run_start' && !ended.has(event.runId)).map((event) => event.runId);
}

function running(job: PublicBackgroundJob): boolean {
  return job.status === 'running';
}

function jobName({ job, helper }: HeldJob): string {
  return `${job.kind} job ${job.id}${job.label === undefined || job.label === null ? '' : ` (${job.label})`}${helper === null ? '' : ` of helper ${helper}`}`;
}

function described(events: readonly RunEvent[], held: Holders): string[] {
  return [
    ...held.runs.map((runId) => {
      const last = events.filter((event) => event.runId === runId).at(-1);

      return `open run ${runId}${last === undefined ? '' : `, its last row ${last.type} at ${last.timestamp}`}`;
    }),
    ...held.helpers.map((helper) => `working helper ${helper.name}`),
    ...held.jobs.map((job) => `running ${jobName(job)}`),
  ];
}

function kinds(held: Holders): string[] {
  return [...new Set([
    ...held.runs.map(() => 'open run'),
    ...held.helpers.map(() => 'working helper'),
    ...held.jobs.map(({ job }) => `running ${job.kind} job`),
  ])];
}

/**
 * One turn's look at its workspace, kept across polls: whether it is busy (a run open, a background job running, a
 * helper working), and since when what streams has said nothing. The ledger writes a step and a call only at their ends,
 * so the rooms the session hears are where a model is seen streaming and a call running: the turn's own, the turns the
 * product opens on its own, and each working helper's, which the watch asks the session to listen to. A job, the lead's
 * or a helper's waiting on its own, streams nothing: it is judged by whether it settled, and the trial's budget bounds it.
 */
export class TurnWatch {
  readonly clock: WatchClock;

  private rows = 0;

  private frames: number;

  private heardAt: number;

  private saidAt: number;

  private readonly helperJobs = new Map<string, { readonly at: number; readonly running: readonly PublicBackgroundJob[] }>();

  private readonly firstSeen = new Map<string, number>();

  constructor(readonly workspace: WatchedWorkspace, private readonly options: WatchOptions = {}) {
    this.clock = options.clock ?? WALL_CLOCK;
    this.heardAt = this.clock.now();
    this.saidAt = this.heardAt;
    this.frames = workspace.heard();
  }

  /** Read the workspace once. Throws a {@link WorkspaceHeld}: hung when what streams has been silent past the bound,
   *  over budget when the trial ran past its budget with the workspace still held. */
  async poll(): Promise<{ busy: boolean; events: readonly RunEvent[] }> {
    const [events, jobs, helpers] = await Promise.all([this.workspace.runEvents(), this.workspace.backgroundJobs(), this.workspace.subordinates()]);
    const working = helpers.filter((helper) => helper.status === 'working');
    const theirs = await this.jobsOfHelpers(working);
    const now = this.clock.now();

    const held: Holders = {
      runs: openRuns(events),
      helpers: working.filter((helper) => (theirs.get(helper.name) ?? []).length === 0),
      jobs: [...jobs.filter(running).map((job) => ({ job, helper: null })), ...[...theirs].flatMap(([helper, own]) => own.map((job) => ({ job, helper })))],
    };

    const busy = held.runs.length > 0 || working.length > 0 || held.jobs.length > 0;
    const frames = this.workspace.heard();

    this.workspace.listen(working.map((helper) => helper.name));

    if (held.runs.length + held.helpers.length === 0 || events.length > this.rows || frames > this.frames || this.workspace.toolCallsInFlight().length > 0) {
      this.heardAt = now;
    }

    this.rows = events.length;
    this.frames = frames;
    this.silence(now, events, held);

    if (busy) this.budget(now, events, held);
    this.waitingOn(now, held.jobs);

    return { busy, events };
  }

  private silence(now: number, events: readonly RunEvent[], held: Holders): void {
    const waits = events.flatMap((event) => (event.type === 'provider_wait' ? [Date.parse(event.timestamp) + event.waitMs] : []));
    const silentMs = now - Math.max(this.heardAt, ...waits);

    if (silentMs <= HUNG_AFTER_MS) return;
    const last = events.at(-1);
    const silent: Holders = { ...held, jobs: [] };
    const meanwhile = held.jobs.length === 0 ? '' : `, with ${held.jobs.map(jobName).join('; ')} running meanwhile`;

    throw new WorkspaceHang(`the workspace stayed busy for ${String(Math.round(silentMs / 1000))} s with no ledger row, no stream byte, `
      + `no tool call in flight and no provider wait declared${last === undefined ? '' : ` (its last row ${last.type} at ${last.timestamp})`}: `
      + `held by ${described(events, silent).join('; ')}${meanwhile}`, kinds(silent));
  }

  private budget(now: number, events: readonly RunEvent[], held: Holders): void {
    const { budget } = this.options;

    if (budget === undefined || now - budget.startedAt <= budget.ms) return;

    throw new TrialOverBudget(`over budget, held by ${described(events, held).join('; ')}: the trial ran `
      + `${String(Math.round((now - budget.startedAt) / 1000))} s, past the ${budget.task} budget of ${String(Math.round(budget.ms / 1000))} s`, kinds(held));
  }

  private waitingOn(now: number, jobs: readonly HeldJob[]): void {
    for (const { job } of jobs) if (!this.firstSeen.has(job.id)) this.firstSeen.set(job.id, now);

    if (jobs.length === 0 || now - this.saidAt < WAITING_LINE_MS) return;
    this.saidAt = now;

    for (const held of jobs) {
      const since = new Date(held.job.createdAt ?? this.firstSeen.get(held.job.id) ?? now).toISOString();

      this.options.waiting?.(`waiting on ${held.helper === null ? '' : `helper ${held.helper}'s `}job ${held.job.id}`
        + `${held.job.label === undefined || held.job.label === null ? '' : ` (${held.job.label})`} since ${since}`);
    }
  }

  /** Each working helper's own running jobs: a task helper whose turn ended with one running stays working until it
   *  settles (core `finishTurn`), streaming nothing meanwhile. */
  private async jobsOfHelpers(working: readonly PublicSubordinate[]): Promise<ReadonlyMap<string, readonly PublicBackgroundJob[]>> {
    const now = this.clock.now();

    for (const name of this.helperJobs.keys()) {
      if (!working.some((helper) => helper.name === name)) this.helperJobs.delete(name);
    }

    await Promise.all(working.map(async ({ name }) => {
      const read = this.helperJobs.get(name);

      if (read !== undefined && now - read.at < HELPER_JOBS_MS) return;
      this.helperJobs.set(name, { at: now, running: (await this.workspace.backgroundJobs(name)).filter(running) });
    }));

    return new Map([...this.helperJobs].map(([name, read]) => [name, read.running]));
  }
}

/**
 * The turn's own answer, watched while its stream is open: a run that goes silent mid-answer holds its stream open with
 * it, so the workspace is looked at until the answer lands or fails, the workspace hangs, or the trial's budget ends.
 */
export async function answered<T>(watch: TurnWatch, sent: Promise<T>): Promise<T> {
  const landing = new AbortController();
  const answer = sent.finally(() => { landing.abort(); });

  for (;;) {
    await Promise.race([answer, watch.clock.sleep(STREAMING_POLL_MS, landing.signal)]);

    if (landing.signal.aborted) return answer;

    try {
      await watch.poll();
    } catch (error) {
      // The stream carries this turn, and its own redial answers a dropped socket: a look the transport lost waits for
      // the next one.
      if (error instanceof WorkspaceHeld || !renderThrownChain({ cause: error }).includes(INFRA_FAILURE_MARKER)) throw error;
    }
  }
}

/** What one poll of {@link settle} saw: whether the workspace was busy, and the ledger it read. */
export type SettlePoll = (busy: boolean, events: readonly RunEvent[]) => void;

/**
 * Wait until the workspace has nothing left to do for this turn: no run open, no background job
 * running, no helper working, seen on two polls in a row. A background job's completion wakes the
 * agent in a run of its own, and that run answers the prompt too. A workspace whose runs and helpers
 * stay silent fails the turn as a {@link WorkspaceHang}, and one still held past the trial's budget
 * as a {@link TrialOverBudget}.
 */
export async function settle(watch: TurnWatch, polled?: SettlePoll): Promise<void> {
  let quiet = 0;
  let dropped = 0;

  for (;;) {
    let busy = true;

    try {
      const seen = await watch.poll();

      busy = seen.busy;
      dropped = 0;
      polled?.(busy, seen.events);
    } catch (error) {
      if (error instanceof WorkspaceHeld) throw error;
      // An eviction closes the socket under the polls in flight, and the next poll redials. Three
      // failed polls in a row is a deployment that is not answering, and fails the trial as that.
      dropped += 1;

      if (!renderThrownChain({ cause: error }).includes(INFRA_FAILURE_MARKER) || dropped >= DROPPED_POLLS) throw error;
    }

    quiet = busy ? 0 : quiet + 1;

    if (quiet >= 2) return;
    await watch.clock.sleep(IDLE_POLL_MS);
  }
}

/** What the agent said after `prompt`, oldest first; wake rows between are the agent's own work. */
export function repliesTo(history: readonly PublicMessage[], prompt: string): string[] {
  const asked = history.map((row) => row.role === 'user' && row.text.trim() === prompt.trim()).lastIndexOf(true);

  if (asked === -1) return [];

  return history.slice(asked + 1).filter((row) => row.role === 'assistant' && row.text.trim() !== '').map((row) => row.text);
}
