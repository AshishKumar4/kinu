/**
 * The facet loop gate (`bun scripts/worker-heap.ts --loop-turns`): every isolate the heap gate's workloads run is
 * profiled from when it appears to the end, and no agent's isolate may hold its event loop {@link LOOP_TURN_BOUND_MS}
 * or longer in one stretch.
 *
 * Measured on the platform 2026-10-23 06:50-07:45Z (throwaway Worker kinu-advisor-probe-1023b, compatibility date
 * 2026-09-30, deleted; /mnt/local/kinu/tmp/advisor-probe-1023b, D14): a Worker Loader facet whose event-loop turns each
 * take 0.1-0.4 s of CPU is reset after about 1-3 s of such CPU, "Durable Object reset because its code was updated", and
 * the reset takes its parent workspace object and every sibling facet with it: 0.42 s turns reset 12 of 13 runs, in a
 * call or detached, with or without SQLite writes; 0.1 s turns x 80 reset 1 of 2; 40 ms turns for 4 s of CPU reset
 * 0 of 2. The same 0.42 s turns in a plain Durable Object or in the parent object reset nothing (4 of 4), and another
 * workspace object was never touched. An agent's isolate is such a facet (D9), so one long-turning agent resets its
 * whole workspace.
 *
 * Read in workerd under a CPU profiler sampling every millisecond: a stretch is a run of samples with JavaScript on the
 * stack and no gap between them past 5 ms. A host pausing the thread that long mid-turn would split a turn the same
 * way, so the driver runs a synchronous control turn every lap on the same thread, and a pause read inside one makes
 * the run unreadable, never green. Blind: turns back to back with no wait between read as one stretch (conservative);
 * a pause outside the control's turns is inferred from theirs, not seen; native work outside JavaScript (`(program)`)
 * reads as waiting; the host's speed against the platform's is unmeasured; and work no workload here runs is unread
 * (the workloads: a step's turns, a cold workspace,
 * heads, the 150-step long turn unadvised, advised and compacted against a 64k window, a failing turn, the 450-step
 * screenshot turn with its chat's seeds, twelve subagents' hires, and 40 advised steps of 50 kB results).
 */
import { PLATFORM_LIMITS } from '../../packages/core/src/platform-limits';
import { longestBusy, pausesUnder, profileEach, profileLoop, targetIds, type BusyStretch, type EachProfiled, type HostPauses, type LoopProfile } from './inspector';

/** The longest stretch an agent's isolate may hold its loop: the shortest turn the platform reset a facet for. */
export const LOOP_TURN_BOUND_MS = PLATFORM_LIMITS['do.facet.cpu_turns_reset_parent'].value;

export interface LoopTurn extends BusyStretch {
  /** workerd's target id: an agent's is `LOADER:kinu-agent:<bundle>:<workspace object id>:<actor id>`. */
  readonly isolate: string;
  /** The workspace and agent it names, or the id itself for an isolate that is no agent's. */
  readonly workload: string;
}

/** An agent's isolate named by its workspace, as the run opened it (`workspaces`, by object id), and its agent. */
function workloadOf(isolate: string, workspaces: ReadonlyMap<string, string>): string {
  const [binding, , , object, actor] = isolate.split(':');

  if (binding !== 'LOADER' || object === undefined || actor === undefined) return isolate;

  return `agent ${actor} of the workspace ${workspaces.get(object) ?? object}`;
}

/** What the loop pass read: each isolate's longest stretch, and the pauses its control turns saw. */
export interface LoopReading {
  readonly turns: readonly LoopTurn[];
  readonly host: HostPauses;
}

/** Prints each isolate's longest stretch, with the frames it ran under, then every agent's isolate at or past the bound
 *  and the gate's blind spots: 1 when an agent's isolate reached it; else 2 when the host paused a control turn (a pause
 *  splits a turn as a wait does) or none was read; else 0. */
export function loopVerdict({ turns, host }: LoopReading): number {
  for (const turn of turns) {
    console.log(`facet-loop: ${turn.ms.toFixed(1)} ms, the longest stretch in ${turn.workload}`);

    for (const { frame, share } of turn.frames) console.log(`  ${(share * 100).toFixed(0).padStart(4)}%  ${frame}`);

    for (const { frame, share } of turn.leaves) console.log(`  ${(share * 100).toFixed(0).padStart(4)}%  in ${frame}`);
  }

  const over = turns.filter((turn) => turn.isolate.startsWith('LOADER:') && turn.ms >= LOOP_TURN_BOUND_MS);
  const longest = Math.max(0, ...host.pauses);

  for (const turn of over) console.error(`facet-loop: ${turn.workload} held its event loop ${turn.ms.toFixed(0)} ms, at or past ${String(LOOP_TURN_BOUND_MS)} ms`);
  console.log(`facet-loop: the host paused the thread ${String(host.pauses.length)} times mid-turn (longest ${longest.toFixed(0)} ms) `
    + `in ${(host.watchedMs / 1000).toFixed(1)} s of control turns`);
  console.log('facet-loop: blind: turns back to back read as one stretch; a pause outside the control turns is inferred from '
    + 'theirs; native work outside JavaScript reads as waiting; this host\'s speed against the platform\'s is unmeasured; '
    + 'the workspace object\'s own isolate is read, not bounded; work no workload runs is unread.');

  if (over.length > 0) return 1;

  if (host.watchedMs === 0) console.error('facet-loop: unreadable: no control turn was read, so a host pause could not be seen');
  else if (host.pauses.length > 0) console.error('facet-loop: unreadable: this host paused the thread mid-turn, which splits a turn as a wait does');
  else return 0;

  return 2;
}

/** The run's control: the isolate whose synchronous turn, `controlTurn` in the driver, reads the host's pauses. */
export interface LoopControl {
  readonly isolate: string;
  readonly turn: () => Promise<string>;
}

/** The driver's control turn, by the name its profile carries (`driver.ts`, bundled unminified). */
const CONTROL_FRAME = 'controlTurn';

/** Watches workerd's isolates as they appear, each profiled from then, and runs a control turn every lap, until `stop`. */
export class LoopWatch {
  private readonly watched = new Map<string, LoopProfile>();
  private readonly skipped = new Set<string>();
  private polling: Promise<void> | null = null;
  private stopping = false;
  private controlled: EachProfiled | null = null;
  private readonly pauses: number[] = [];
  private watchedMs = 0;

  /** `includes`: the isolates to profile, by target id (the gate's own driver is not the product's). */
  constructor(private readonly port: number, private readonly includes: (id: string) => boolean, private readonly control: LoopControl) {}

  async start(): Promise<void> {
    const controlled = await profileEach(this.port, this.control.isolate);

    if (controlled === null) throw new Error(`facet-loop: no control isolate ${this.control.isolate}`);
    this.controlled = controlled;
    await this.attachNew();
    this.polling = this.poll(controlled);
  }

  /** Each isolate's longest busy stretch, longest first, an agent's named by its workspace (`workspaces`, by object id),
   *  and the host's pauses in the control turns. */
  async stop(workspaces: ReadonlyMap<string, string>): Promise<LoopReading> {
    if (this.controlled === null) throw new Error('facet-loop: stopped before it started');
    this.stopping = true;
    await this.polling;
    const turns: LoopTurn[] = [];

    for (const [isolate, profile] of this.watched) turns.push({ isolate, workload: workloadOf(isolate, workspaces), ...longestBusy(await profile.stop()) });
    this.controlled.close();

    return { turns: turns.sort((a, b) => b.ms - a.ms), host: { pauses: this.pauses, watchedMs: this.watchedMs } };
  }

  /** Until `stop`. An isolate that comes and goes within one poll is not profiled; none of the workloads' does. */
  private async poll(controlled: EachProfiled): Promise<void> {
    while (!this.stopping) {
      // Each control turn its own profile: two in one would read the wait between them as a pause.
      const { pauses, watchedMs } = pausesUnder(await controlled.around(this.control.turn), CONTROL_FRAME);

      this.pauses.push(...pauses);
      this.watchedMs += watchedMs;
      await Bun.sleep(200);
      await this.attachNew();
    }
  }

  private async attachNew(): Promise<void> {
    for (const id of await targetIds(this.port)) {
      if (this.watched.has(id) || this.skipped.has(id)) continue;

      if (!this.includes(id)) {
        this.skipped.add(id);
        continue;
      }

      const profile = await profileLoop(this.port, id);

      if (profile === null) this.skipped.add(id);
      else this.watched.set(id, profile);
    }
  }
}
