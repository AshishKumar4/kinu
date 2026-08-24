import { statSync } from 'node:fs';
import { requireAuthConfig } from '../config';
import {
  callAgentRpc,
  CloudAgentStatusSchema,
  CloudBackgroundJobSchema,
  CloudToolDescriptionsSchema,
  CloudTriggerListSchema,
  type CloudAgentStatus,
} from '../cloud-api';
import * as v from 'valibot';
import { ACCENT, DIM, OK, printAgentStatus } from '../display';
import { resolveAgentTarget } from '../agent-target';
import { requireLocalAgent } from '../local-target';
import { getLocalAgentInfo } from '../local-inspection';

export async function statusCommand(name: string): Promise<void> {
  const target = resolveAgentTarget(name);
  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    const [status, tools, triggers, jobs] = await Promise.all([
      callAgentRpc(auth.origin, auth.token, target.cloudName, 'getAgentStatus', CloudAgentStatusSchema),
      callAgentRpc(auth.origin, auth.token, target.cloudName, 'getToolDescriptions', CloudToolDescriptionsSchema),
      callAgentRpc(auth.origin, auth.token, target.cloudName, 'listTriggers', CloudTriggerListSchema),
      callAgentRpc(auth.origin, auth.token, target.cloudName, 'listBackgroundJobs', v.array(CloudBackgroundJobSchema), [10]),
    ]);
    printCloudStatus(target.name, status, {
      builtInTools: tools.builtIn.length,
      craftedTools: tools.crafted.length,
      executorCount: tools.executors.length,
      triggerCount: triggers.triggers.length,
      runningJobs: jobs.filter((j) => j.status === 'running').length,
      jobCount: jobs.length,
    });
    return;
  }
  const local = requireLocalAgent(target.requestedName, { adopt: false });
  const info = getLocalAgentInfo(local.name);
  const dbSize = statSync(local.dbPath).size;
  printAgentStatus(info, dbSize, {
    conversationCount: info.conversationCount,
    model: info.model,
    reasoningEffort: info.reasoningEffort,
  });
}

function printCloudStatus(
  name: string,
  status: CloudAgentStatus,
  counts: {
    builtInTools: number;
    craftedTools: number;
    executorCount: number;
    triggerCount: number;
    runningJobs: number;
    jobCount: number;
  },
): void {
  console.log('');
  console.log(`${ACCENT(name)} ${DIM('cloud workspace')}`);
  console.log(`${DIM('State')}      ${OK('connected')}`);
  console.log(`${DIM('Mission')}    ${status.purpose || DIM('(none)')}`);
  console.log(`${DIM('Model')}      ${status.model ?? DIM('(default)')}`);
  console.log(`${DIM('Effort')}     ${status.reasoningEffort ?? 'medium (chat default)'}`);
  console.log(`${DIM('Messages')}   ${status.messageCount}`);
  console.log(`${DIM('Scaffold')}   v${status.scaffoldVersion}`);
  console.log(`${DIM('MCTS')}       ${status.searchNodeCount} node${status.searchNodeCount === 1 ? '' : 's'}`);
  console.log(`${DIM('Tools')}      ${counts.builtInTools} built-in, ${counts.craftedTools} crafted, ${counts.executorCount} executor${counts.executorCount === 1 ? '' : 's'}`);
  console.log(`${DIM('Triggers')}   ${counts.triggerCount}`);
  console.log(`${DIM('Jobs')}       ${counts.runningJobs} running, ${counts.jobCount} recent`);
  console.log('');
}
