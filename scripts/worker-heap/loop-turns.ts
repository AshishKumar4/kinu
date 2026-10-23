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
 * stack and no gap between them past {@link LOOP_GAP_US}. Blind: turns back to back with no wait between read as one
 * stretch (conservative); native work outside JavaScript (`(program)`) reads as waiting; the host's speed against the
 * platform's is unmeasured; and work no workload here runs is unread (the workloads: a step's turns, a cold workspace,
 * heads, the 150-step long turn unadvised and advised, a failing turn, the 450-step screenshot turn with its chat's
 * seeds, and twelve subagents' hires).
 */
import { profileEveryIsolate, profileLoop, targetIds, type BusyStretch, type LoopProfile } from './inspector';

/** The longest stretch an agent's isolate may hold its loop: the shortest turn the platform reset a facet for. */
export const LOOP_TURN_BOUND_MS = 100;

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

/** Prints each isolate's longest stretch, with the frames it ran under, then every agent's isolate at or past the bound
 *  and the gate's blind spots: 0 when no agent's isolate reached it, else 1. */
export function loopVerdict(turns: readonly LoopTurn[]): number {
  for (const turn of turns) {
    console.log(`facet-loop: ${turn.ms.toFixed(1)} ms, the longest stretch in ${turn.workload}`);

    for (const { frame, share } of turn.frames) console.log(`  ${(share * 100).toFixed(0).padStart(4)}%  ${frame}`);
  }

  const over = turns.filter((turn) => turn.isolate.startsWith('LOADER:') && turn.ms >= LOOP_TURN_BOUND_MS);

  for (const turn of over) console.error(`facet-loop: ${turn.workload} held its event loop ${turn.ms.toFixed(0)} ms, at or past ${String(LOOP_TURN_BOUND_MS)} ms`);
  console.log('facet-loop: blind: turns back to back read as one stretch; native work outside JavaScript reads as waiting; '
    + 'this host\'s speed against the platform\'s is unmeasured; the workspace object\'s own isolate is read, not bounded; '
    + 'work no workload runs is unread.');

  return over.length > 0 ? 1 : 0;
}

/** Watches workerd's isolates as they appear, each profiled from then, until `stop`. */
export class LoopWatch {
  private readonly watched = new Map<string, LoopProfile>();
  private readonly skipped = new Set<string>();
  private polling: Promise<void> | null = null;
  private stopping = false;

  /** `includes`: the isolates to profile, by target id (the gate's own driver is not the product's). */
  constructor(private readonly port: number, private readonly includes: (id: string) => boolean) {}

  async start(): Promise<void> {
    profileEveryIsolate();
    await this.attachNew();
    this.polling = this.poll();
  }

  /** Each isolate's longest busy stretch, longest first, an agent's named by its workspace (`workspaces`, by object id). */
  async stop(workspaces: ReadonlyMap<string, string>): Promise<LoopTurn[]> {
    this.stopping = true;
    await this.polling;
    const turns: LoopTurn[] = [];

    for (const [isolate, profile] of this.watched) turns.push({ isolate, workload: workloadOf(isolate, workspaces), ...await profile.stop() });

    return turns.sort((a, b) => b.ms - a.ms);
  }

  /** Until `stop`. An isolate that comes and goes within one poll is not profiled; none of the workloads' does. */
  private async poll(): Promise<void> {
    while (!this.stopping) {
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
