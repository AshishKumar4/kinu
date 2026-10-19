/**
 * A run delivered to an agent (design v2 §1, D2), driven to its end: opened, its rounds run by core's head inference,
 * and closed by one commit that holds its brief and its answer in the agent's chat, its run's end, every claim of its
 * rounds still open, and its end as its host keeps it. A restart finds it ended and told, never one to run again. Its
 * host supplies each round's preparation and what its end records; what the run does around that is here, once.
 */
import type { HostedActor } from '../state/actor-host';
import type { AgentTurnTask } from '../subordinates/agent-isolate';
import { classifyRunEnd, closeRunIn, closeTurnRun, openTurnRun } from '../orchestrator/turn-lifecycle';
import { runMetadata } from '../orchestrator/chat-queue';
import { CHAT_SESSION_ID } from '../session/transcript-schema';
import { authoredTurnMetadata } from '../types/turn-metadata';
import { runHeadInference, type HeadRun } from './head-inference';
import type { HeadReport } from './types';

export interface DeliveredRunPorts {
  /** Each round's preparation, under that round's claim: what the host binds its calls to. */
  readonly prepare: HeadRun['prepare'];
  /** The run's end as its host keeps it, prepared before the commit; the call it answers keeps it inside the commit. */
  readonly ended: (outcome: HeadReport) => Promise<() => void>;
}

export async function driveDeliveredRun(actor: HostedActor, task: AgentTurnTask, ports: DeliveredRunPorts): Promise<void> {
  const { runId, sequenceId: turnId } = task;
  const recorder = actor.stores.eventRecorder;
  const transcript = actor.stores.history.transcript(CHAT_SESSION_ID);

  openTurnRun(recorder, runId, {
    agentId: actor.record.actorId, causedBy: 'swarm', userMessage: task.body,
    turnIndex: actor.session.orchestrator.sessionTurnIndex,
  });

  const report = await runHeadInference({ key: { turnId, runId, mode: task.mode }, actor, prepare: ports.prepare });
  const completion = report.canonicalCompletion;

  // Nothing crosses between the run's last step and its commit: a death there would run the run again (#75). Its chat
  // holds what it was asked, whole, and its answer, as a chat turn's does.
  const asked = await actor.session.canonical.admitInput({
    id: turnId, turnId, message: { role: 'user', content: task.body }, assertOwner: () => { actor.handle.assertCurrent(); },
  });

  const brief = await transcript.prepareUser({ id: turnId, turnId, runId, message: asked, metadata: authoredTurnMetadata({ kind: 'programmatic', metadata: runMetadata(task) }) });

  const answer = completion === undefined ? null : await transcript.prepareAssistant({
    id: crypto.randomUUID(), turnId: completion.turnId, runId: completion.runId, parts: completion.outputPartReferences,
    finalText: completion.finalTextReference,
  });

  const keepEnd = await ports.ended(report);

  actor.runtime.storage.transactionSync(() => closeRunIn(recorder, () => {
    closeTurnRun(recorder, runId, {
      turnIndex: actor.session.orchestrator.sessionTurnIndex,
      usage: report.usage,
      workMode: actor.session.workMode,
      ...classifyRunEnd({ completed: report.status === 'completed', interrupted: report.status === 'aborted', errorText: report.errorMessage }),
    });
    transcript.appendUser(brief);

    if (answer !== null) transcript.appendAssistant(answer);
    keepEnd();

    // A round a dead isolate opened and the run, run again, never reached: the run's end is its end too.
    return actor.stores.claims.settleRunIn(runId, 'indeterminate');
  }))();
}
