import { silenceBoundMs, type RunEvent } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { INFRA_FAILURE_MARKER } from '@kinu.run/test-utils';
import type { KinuPublicSession, PublicBackgroundJob, PublicMessage, PublicSubordinate } from './session';

/** How often an unsettled workspace is looked at. A poll, not a deadline: only a hang ends a turn here. A poll reads
 *  only what the ledger added since the last one, so a short interval costs the deployment little. */
const IDLE_POLL_MS = 1_000;

/** How often the workspace is looked at while the turn's own stream is open, for a hang alone. Each look reads every
 *  run's new rows over HTTP: once a second for 180 trials at once is hundreds of requests a second at the build. */
const STREAMING_POLL_MS = 30_000;

/** Polls in a row the deployment's transport may fail before the trial fails as infrastructure. */
const DROPPED_POLLS = 3;

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

/** A turn whose workspace stayed busy and silent past the bound: the build hung, and the message names what held it. */
export class WorkspaceHang extends Error {
  override readonly name = 'WorkspaceHang';
}

function openRuns(events: readonly RunEvent[]): string[] {
  const ended = new Set(events.filter((event) => event.type === 'run_end').map((event) => event.runId));

  return events.filter((event) => event.type === 'run_start' && !ended.has(event.runId)).map((event) => event.runId);
}

function holders(events: readonly RunEvent[], jobs: readonly PublicBackgroundJob[], helpers: readonly PublicSubordinate[]): string[] {
  return [
    ...openRuns(events).map((runId) => {
      const last = events.filter((event) => event.runId === runId).at(-1);

      return `open run ${runId}${last === undefined ? '' : `, its last row ${last.type} at ${last.timestamp}`}`;
    }),
    ...jobs.map((job) => `running ${job.kind} job ${job.id}`),
    ...helpers.map((helper) => `working helper ${helper.name}`),
  ];
}

/**
 * One turn's look at its workspace, kept across polls: whether it is busy (a run open, a background job running, a
 * helper working), and since when it has said nothing. The ledger writes a step and a call only at their ends, so the
 * rooms the session hears are where a model is seen streaming and a call running: the turn's own, the turns the product
 * opens on its own, and each working helper's, which the watch asks the session to listen to.
 */
export class TurnWatch {
  private rows = 0;

  private frames: number;

  private heardAt: number;

  constructor(readonly workspace: WatchedWorkspace, readonly clock: WatchClock = WALL_CLOCK) {
    this.heardAt = clock.now();
    this.frames = workspace.heard();
  }

  /** Read the workspace once. Throws {@link WorkspaceHang} when it has been busy and silent past the bound. */
  async poll(): Promise<{ busy: boolean; events: readonly RunEvent[] }> {
    const [events, jobs, helpers] = await Promise.all([this.workspace.runEvents(), this.workspace.backgroundJobs(), this.workspace.subordinates()]);
    const now = this.clock.now();
    const running = jobs.filter((job) => job.status === 'running');
    const working = helpers.filter((helper) => helper.status === 'working');
    const busy = openRuns(events).length > 0 || running.length > 0 || working.length > 0;
    const frames = this.workspace.heard();

    this.workspace.listen(working.map((helper) => helper.name));

    if (!busy || events.length > this.rows || frames > this.frames || this.workspace.toolCallsInFlight().length > 0) this.heardAt = now;
    this.rows = events.length;
    this.frames = frames;

    const waits = events.flatMap((event) => (event.type === 'provider_wait' ? [Date.parse(event.timestamp) + event.waitMs] : []));
    const silentMs = now - Math.max(this.heardAt, ...waits);

    if (silentMs > HUNG_AFTER_MS) {
      const last = events.at(-1);

      throw new WorkspaceHang(`the workspace stayed busy for ${String(Math.round(silentMs / 1000))} s with no ledger row, no stream byte, `
        + `no tool call in flight and no provider wait declared${last === undefined ? '' : ` (its last row ${last.type} at ${last.timestamp})`}: `
        + `held by ${holders(events, running, working).join('; ')}`);
    }

    return { busy, events };
  }
}

/**
 * The turn's own answer, watched while its stream is open: a run that goes silent mid-answer holds its stream open with
 * it, so the workspace is looked at for a hang until the answer lands or fails.
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
      if (error instanceof WorkspaceHang || !renderThrownChain({ cause: error }).includes(INFRA_FAILURE_MARKER)) throw error;
    }
  }
}

/** What one poll of {@link settle} saw: whether the workspace was busy, and the ledger it read. */
export type SettlePoll = (busy: boolean, events: readonly RunEvent[]) => void;

/**
 * Wait until the workspace has nothing left to do for this turn: no run open, no background job
 * running, no helper working, seen on two polls in a row. A background job's completion wakes the
 * agent in a run of its own, and that run answers the prompt too. A workspace that stays busy and
 * silent fails the turn as a {@link WorkspaceHang}.
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
      if (error instanceof WorkspaceHang) throw error;
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
