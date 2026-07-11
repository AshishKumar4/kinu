import { existsSync, statSync } from 'node:fs';
import { agentDbPath, requireAuthConfig } from '../config.js';
import {
  callAgentRpc,
  type CloudAgentStatus,
  type CloudBackgroundJob,
  type CloudToolDescriptions,
  type CloudTriggerList,
} from '../cloud-api.js';
import { ACCENT, DIM, OK, printAgentStatus, printError } from '../display.js';
import { resolveAgentTarget } from '../agent-target.js';
import { getLocalAgentInfo } from '../local-inspection.js';

export async function statusCommand(name: string): Promise<void> {
  const target = resolveAgentTarget(name);
  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    const [status, tools, triggers, jobs] = await Promise.all([
      callAgentRpc<CloudAgentStatus>(auth.origin, auth.token, target.cloudName, 'getAgentStatus'),
      callAgentRpc<CloudToolDescriptions>(auth.origin, auth.token, target.cloudName, 'getToolDescriptions'),
      callAgentRpc<CloudTriggerList>(auth.origin, auth.token, target.cloudName, 'listTriggers'),
      callAgentRpc<CloudBackgroundJob[]>(auth.origin, auth.token, target.cloudName, 'listBackgroundJobs', [10]),
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
  name = target.localName;
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    printError(`Workspace "${name}" not found.`, `Create it with: proteus create ${name}`);
    process.exit(1);
  }

  const info = getLocalAgentInfo(name);
  const dbSize = statSync(dbPath).size;
  printAgentStatus(info, dbSize, { conversationCount: info.conversationCount });
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
  console.log(`${DIM('Messages')}   ${status.messageCount}`);
  console.log(`${DIM('Scaffold')}   v${status.scaffoldVersion}`);
  console.log(`${DIM('MCTS')}       ${status.searchNodeCount} node${status.searchNodeCount === 1 ? '' : 's'}`);
  console.log(`${DIM('Tools')}      ${counts.builtInTools} built-in, ${counts.craftedTools} crafted, ${counts.executorCount} executor${counts.executorCount === 1 ? '' : 's'}`);
  console.log(`${DIM('Triggers')}   ${counts.triggerCount}`);
  console.log(`${DIM('Jobs')}       ${counts.runningJobs} running, ${counts.jobCount} recent`);
  console.log('');
}
