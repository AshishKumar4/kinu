import { statSync } from 'node:fs';
import { effectiveRoleCatalog } from '@kinu.run/core';
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
import { ACCENT, DIM, OK, plural, printAgentStatus } from '../display';
import { resolveAgentTarget } from '../agent-target';
import { requireLocalAgent } from '../local-target';
import { getLocalAgentInfo, getLocalProfileCoordinates } from '../local-inspection';
import { createProfileAuthorityReader } from '../profiles';

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
  const coordinates = getLocalProfileCoordinates(local.name);
  const envelope = await createProfileAuthorityReader()();
  if (envelope === null) {
    printAgentStatus(info, statSync(local.dbPath).size, {
      conversationCount: info.conversationCount,
      model: info.model,
      reasoningEffort: info.reasoningEffort,
    });
    return;
  }
  const roles = effectiveRoleCatalog(envelope.catalog);
  const role = roles[coordinates.roleId] ?? roles.general;
  const tierId = coordinates.assignedTier ?? role?.tier ?? 'default';
  const tier = envelope.catalog.tiers[tierId] ?? envelope.catalog.tiers.default;
  const dbSize = statSync(local.dbPath).size;
  printAgentStatus(info, dbSize, {
    conversationCount: info.conversationCount,
    model: tier?.model ?? info.model,
    reasoningEffort: tier?.reasoningEffort ?? info.reasoningEffort,
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
  console.log(`${DIM('MCTS')}       ${plural(status.searchNodeCount, 'node')}`);
  console.log(`${DIM('Tools')}      ${counts.builtInTools} built-in, ${counts.craftedTools} crafted, ${plural(counts.executorCount, 'executor')}`);
  console.log(`${DIM('Triggers')}   ${counts.triggerCount}`);
  console.log(`${DIM('Jobs')}       ${counts.runningJobs} running, ${counts.jobCount} recent`);
  console.log('');
}
