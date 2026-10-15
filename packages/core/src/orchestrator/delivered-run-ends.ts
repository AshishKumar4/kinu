/**
 * The ends of the runs delivered to an agent (D2): each kept on its run's held row as its host answers the run, told by
 * the agent's next report to its workspace, and retired once a report carrying it reached there. A restart tells what
 * the last process kept and never told; it never runs the run again.
 */
import * as v from 'valibot';
import { Effect } from 'effect';
import { attempt, diagnostics, KinuError, settle } from '../obs/index';
import type { SessionPayload } from '../session/payload';
import type { SessionTranscript } from '../session/transcript';
import { refusedRun, type RunEndOutcome, type RunEndReport } from '../subordinates/agent-isolate';
import { turnTags } from '../types/turn-metadata';
import { parseJsonObject, type JsonObject } from '../utils/json';
import type { PendingSendStore } from './inbox';

/** A run's end as {@link runEndJson} kept it, read back by the store that wrote it. */
const RunEndOutcomeSchema = v.custom<RunEndOutcome>((input) => v.is(v.union([v.object({ ended: v.looseObject({}) }), v.object({ refused: v.object({ code: v.string(), message: v.string() }) })]), input));

/** A run's end as its held row keeps it: JSON, its absent fields dropped. */
function runEndJson(outcome: RunEndOutcome): JsonObject {
  return parseJsonObject(JSON.stringify(outcome));
}

export class DeliveredRunEnds {
  constructor(private readonly deps: {
    readonly pendingSends: PendingSendStore;
    /** Where a kept end lives: inline below the row bound, spilled to a file above. */
    readonly payloads: Pick<SessionTranscript, 'payload' | 'preparePayload'>;
    readonly transaction: <T>(body: () => T) => T;
  }) {}

  /** Run `id`'s end, prepared to keep: the returned call, run in the commit that answers the run, keeps it on its row. */
  async keep(id: string, outcome: RunEndOutcome): Promise<() => void> {
    const kept = await this.deps.payloads.preparePayload(runEndJson(outcome));

    return () => { this.deps.pendingSends.recordRunEnd(id, kept); };
  }

  /** Each end kept here and not yet told, as the agent's next report carries it. */
  owed(): Promise<RunEndReport[]> {
    return settle(Effect.gen({ self: this }, function* () {
      const owed: RunEndReport[] = [];

      for (const { id, metadata, end } of this.deps.pendingSends.runEnds()) {
        const held = turnTags({ metadata }).run;

        if (held !== undefined) owed.push({ id, runId: held, outcome: yield* this.kept(end) });
      }

      return owed;
    }));
  }

  /** A report carrying these ends reached the workspace: their runs are owed no more. A newer generation held under the
   *  same id since is not one of them. */
  told(told: readonly RunEndReport[]): void {
    this.deps.transaction(() => {
      const held = this.deps.pendingSends.runEnds().map(({ id, metadata }) => ({ id, run: turnTags({ metadata }).run }));

      for (const end of told) {
        if (held.some((kept) => kept.id === end.id && kept.run === end.runId)) this.deps.pendingSends.retireTurn(end.id);
      }
    });
  }

  /** A run's end as it was kept. One that cannot be read back (its spilled file gone or changed) is told as the refusal
   *  it is, and retires with its telling: one unreadable end never holds back the agent's other reports. */
  private kept(end: SessionPayload): Effect.Effect<RunEndOutcome> {
    return attempt({ doing: "reading a delivered run's kept end", otherwise: 'io' }, () => this.deps.payloads.payload(end)).pipe(
      Effect.map((kept) => v.safeParse(RunEndOutcomeSchema, kept)),
      Effect.flatMap((parsed) => (parsed.success ? Effect.succeed(parsed.output) : Effect.fail(new KinuError('io', "a delivered run's kept end is not one")))),
      Effect.catch((failure) => Effect.sync(() => {
        diagnostics.failure('agent.run_end_unreadable', failure);

        return refusedRun(failure);
      })),
    );
  }
}
