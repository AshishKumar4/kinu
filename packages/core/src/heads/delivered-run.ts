/**
 * A run delivered to an agent (design v2 §1, D2), driven to its end: opened, its rounds run by core's head inference,
 * and closed by one commit that holds its answer, its run's end, every claim of its rounds still open, and its end as its
 * host keeps it. A restart finds it ended and told, never one to run again. Its host supplies each round's preparation
 * and what its end records; what the run does around that is here, once.
 */
import type { HostedActor } from '../state/actor-host';
import type { AgentTurnTask } from '../subordinates/agent-isolate';
import { classifyRunEnd, closeRunIn, closeTurnRun, openTurnRun } from '../orchestrator/turn-lifecycle';
import { runHeadInference, type HeadRun } from './head-inference';
import type { HeadReport } from './types';

export interface DeliveredRunPorts {
  /** Each round's preparation, under that round's claim: what the host binds its calls to. */
  readonly prepare: HeadRun['prepare'];
  /** The answer the run committed, prepared before its commit; the call it answers writes it inside the commit. */
  readonly prepareAnswer: (completion: NonNullable<HeadReport['canonicalCompletion']>) => Promise<() => void>;
  /** The run's end as its host keeps it, prepared before the commit; the call it answers keeps it inside the commit. */
  readonly ended: (outcome: HeadReport) => Promise<() => void>;
}

export async function driveDeliveredRun(actor: HostedActor, task: AgentTurnTask, ports: DeliveredRunPorts): Promise<void> {
  const { runId } = task;
  const recorder = actor.stores.eventRecorder;

  openTurnRun(recorder, runId, {
    agentId: actor.record.actorId, causedBy: 'swarm', userMessage: task.body,
    turnIndex: actor.session.orchestrator.sessionTurnIndex,
  });

  const report = await runHeadInference({ key: { turnId: task.sequenceId, runId, mode: task.mode }, actor, prepare: ports.prepare });
  const completion = report.canonicalCompletion;
  // Nothing crosses between the run's last step and its commit: a death there would run the run again (#75).
  const answer = completion === undefined ? () => {} : await ports.prepareAnswer(completion);
  const keepEnd = await ports.ended(report);

  actor.runtime.storage.transactionSync(() => closeRunIn(recorder, () => {
    closeTurnRun(recorder, runId, {
      turnIndex: actor.session.orchestrator.sessionTurnIndex,
      usage: report.usage,
      workMode: actor.session.workMode,
      ...classifyRunEnd({ completed: report.status === 'completed', interrupted: report.status === 'aborted', errorText: report.errorMessage }),
    });
    answer();
    keepEnd();

    // A round a dead isolate opened and the run, run again, never reached: the run's end is its end too.
    return actor.stores.claims.settleRunIn(runId, 'indeterminate');
  }))();
}
