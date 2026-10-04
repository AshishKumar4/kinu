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
import { ACCENT, DIM, OK, plural, printAgentStatus } from '../display';
import { resolveAgentTarget } from '../agent-target';
import { requireLocalAgent } from '../local-target';
import { getLocalAgentInfo, readLocalNextTurnTier } from '../local-inspection';
import type { LocalModelResolverOptions } from '../local-model-resolver';

const NO_MODEL = 'none yet (kinu setup picks one)';

export async function statusCommand(name: string, opts: LocalModelResolverOptions = {}): Promise<void> {
  const target = resolveAgentTarget(name);

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();

    const [status, tools, triggers, jobs] = await Promise.all([
      callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'getAgentStatus',
        schema: CloudAgentStatusSchema,
      }),
      callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'getToolDescriptions',
        schema: CloudToolDescriptionsSchema,
      }),
      callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'listTriggers',
        schema: CloudTriggerListSchema,
      }),
      callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'listBackgroundJobs',
        schema: v.array(CloudBackgroundJobSchema),
        args: [10],
      }),
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

  const local = requireLocalAgent(target.requestedName);
  const info = getLocalAgentInfo(local.name);
  const tier = await readLocalNextTurnTier(local.name, opts);

  printAgentStatus(info, statSync(local.dbPath).size, {
    conversationCount: info.conversationCount,
    model: tier?.model ?? NO_MODEL,
    reasoningEffort: tier === null ? info.reasoningEffort : tier.reasoningEffort,
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
  console.log(`${DIM('Swarm')}      ${plural(status.searchNodeCount, 'node')}`);
  console.log(`${DIM('Tools')}      ${counts.builtInTools} built-in, ${counts.craftedTools} crafted, ${plural(counts.executorCount, 'executor')}`);
  console.log(`${DIM('Triggers')}   ${counts.triggerCount}`);
  console.log(`${DIM('Jobs')}       ${counts.runningJobs} running, ${counts.jobCount} recent`);
  console.log('');
}
