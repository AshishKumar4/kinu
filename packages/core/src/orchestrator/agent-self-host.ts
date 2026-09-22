/** The one {@link AgentSelfHost} both backends register behind `agent.*` (provider: tools/agent-self.ts). */

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

/** Stores are read when a tool runs; trigger revocation, forced compaction and the budget governor are backend-specific. */
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
