import { mergeAccountSpend, readAccountUsage, type AccountUsage } from '@kinu.run/core';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';
import { getCloudAccountUsage } from './cloud-api';
import { listLocalRefsAllProjects, listUnplacedAgentNames, resolveCloudSession } from './config';
import { getLocalAccountSpend } from './local-inspection';

async function cloudAccountUsage(session: { origin: string; token: string }): Promise<AccountUsage> {
  try {
    return await getCloudAccountUsage(session.origin, session.token);
  } catch (cause) {
    diagnostics.failure('spend.cloud_usage_unread', toKinuError({
      doing: 'reading your cloud workspaces\' spend per account',
      cause,
      otherwise: 'unavailable',
    }));

    return { accounts: [], workspaces: 0, unread: ['your cloud workspaces'] };
  }
}

export async function readAllAccountUsage(): Promise<AccountUsage> {
  const session = resolveCloudSession();
  const names = [...listLocalRefsAllProjects().map((ref) => ref.name), ...listUnplacedAgentNames()];

  const [local, cloud] = await Promise.all([
    readAccountUsage(names.map((name) => ({ name, read: async () => getLocalAccountSpend(name) }))),
    session === null ? null : cloudAccountUsage(session),
  ]);

  if (cloud === null) return local;

  return {
    accounts: mergeAccountSpend([local.accounts, cloud.accounts]),
    workspaces: local.workspaces + cloud.workspaces,
    unread: [...local.unread, ...cloud.unread],
  };
}
