/**
 * The one {@link AgentSelfHost} both backends register behind `agent.*`.
 *
 * The provider is a tool (tools/agent-self.ts); what it reaches is the
 * harness's own curriculum, scaffold, replay, trigger and job planes, so the
 * host that joins the two lives here.
 */

import type { AgentSelfHost } from '../tools/agent-self';
import type { MissionGovernor } from '../mission-budget';
import type { AgentRuntime } from '../types/agent-runtime';
import type { TriggerRegistry } from '../events/hub/triggers';
import type { BackgroundJobStore } from '../jobs/store';
import { createTimerTrigger } from '../events/ingress/triggers';
import { listProposedTasks, updateProposedTaskStatus } from '../curriculum/proposer';
import { proposeCurriculumTasks } from '../read-models/evolution-views';
import { jobResult, listBackgroundJobs } from '../read-models/background-jobs';
import { listScaffoldVersions, proposeScaffold, type ScaffoldControl } from '../evolution/control';
import { listReplayEvals } from '../evolution/replay';

/**
 * What a backend hands the `agent.*` tools: its runtime and stores, read when a
 * tool runs, and the three answers that are its platform's. A trigger is
 * revoked with its webhook secret on a Durable Object and re-arms the local
 * alarm on the CLI; a forced compaction is armed under the backend's own
 * session key; the budget governor is the one the backend built.
 */
export interface AgentSelfPorts {
  readonly rt: AgentRuntime;
  readonly scaffoldControl: () => ScaffoldControl;
  readonly triggers: () => TriggerRegistry;
  readonly jobs: () => BackgroundJobStore;
  readonly budget: () => MissionGovernor;
  readonly cancelTrigger: AgentSelfHost['cancelTrigger'];
  readonly armCompactNow: () => void;
}

export function agentSelfHost(ports: AgentSelfPorts): AgentSelfHost {
  const { rt } = ports;

  return {
    proposeCurriculumTasks: (count) => proposeCurriculumTasks(rt, count),
    listCurriculumTasks: async (status) => listProposedTasks(rt, status),
    setCurriculumTaskStatus: async (id, status) => {
      updateProposedTaskStatus(rt, id, status);

      return { ok: true };
    },
    proposeScaffold: (rationale, code, baseVersion) =>
      proposeScaffold(ports.scaffoldControl(), rationale, code, baseVersion),
    listScaffoldVersions: async (limit) => listScaffoldVersions(rt.storage.sql, rt.actor, limit),
    createTimerTrigger: (opts) => createTimerTrigger(ports.triggers(), opts, Date.now()),
    get budget() { return ports.budget(); },
    cancelTrigger: ports.cancelTrigger,
    jobResult: async (jobId) => jobResult(ports.jobs(), jobId),
    listBackgroundJobs: async (limit) => listBackgroundJobs(ports.jobs(), limit),
    getReplayEvals: async (limit) => listReplayEvals(rt.storage.sql, rt.actor, limit),
    armCompactNow: ports.armCompactNow,
  };
}
