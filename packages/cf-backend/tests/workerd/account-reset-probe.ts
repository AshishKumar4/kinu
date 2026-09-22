/**
 * Account deletion on the real UserDO over workerd: only the platform can show `destroy()` takes every
 * table and the same id then addresses a fresh object, and that torn-down workspaces hold no capability.
 * Addressed by the owner's user id, which `deleteAccount` hands to each workspace's `destroyAgent`.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { ownerCaller } from '@kinu.run/core';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { USER_DO_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import { UserDO, type UserProfile } from '../../src/user/user-do';

// Bound under production names: `deleteAccount` reaches workspaces through `env.OrchestratorAgent`.
export { UserDO } from '../../src/user/user-do';

export { OrchestratorAgent } from '../../src/orchestrator';

// A Worker module may export only handlers and classes, so fixture values stay module-private.
const RESET_OWNER_ID = '0123456789abcdef0123456789abcdef';

const RESET_WORKSPACES = ['ws-alpha', 'ws-beta'] as const;

type WorkspaceHashes = Record<(typeof RESET_WORKSPACES)[number], string | null>;

interface SeededAccount {
  hashes: WorkspaceHashes;
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

type ClaimTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator, 'claimOwner' | 'getWorkspaceCapabilityHash'>;

const ACCOUNT_TABLE_PREFIXES = ['user_', 'device_', 'cli_', 'codex_'];

export class AccountResetProbeDO extends UserDO {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof UserDO>[1]) {
    super(ctx, env);

    for (const name of ['seed', 'counts', 'hashes', 'reset', 'freshProfile']) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...USER_DO_RPC_SURFACE, 'seed', 'counts', 'hashes', 'reset', 'freshProfile']);
  }

  private async workspaceTarget(workspace: string): Promise<ClaimTarget> {
    return getAgentByName<ProbeEnv, ProductionOrchestrator>(this.env.OrchestratorAgent, workspace);
  }

  /** One row in every store the delete has to empty. */
  async seed(): Promise<SeededAccount> {
    const owner = await ownerCaller(this.env);
    await this.ensureProfile(owner, 'owner@probe.local', 'Owner');

    for (const name of RESET_WORKSPACES) {
      await this.registerWorkspace(owner, name, name);
      const target = await this.workspaceTarget(name);
      const claim = await target.claimOwner(RESET_OWNER_ID);
      await this.ensureWorkspaceCapability(name, claim.capabilityHash);
    }

    await this.sharesReceived_add(owner, {
      ownerUserId: 'f'.repeat(32), ownerEmail: 'sam@example.test', workspace: 'their-ws', shareId: 'share-1', title: 'Issue triage',
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO user_mcp_servers (id, name, server_url, transport) VALUES ('srv-1', 'github', 'https://mcp.example/v1', 'auto')`,
    );
    await this.setCredential(owner, 'anthropic.bearer', { kind: 'bearer', token: 'sk-probe' });
    this.ctx.storage.sql.exec(`INSERT INTO device_consent (agent_name, device_id, policy) VALUES ('ws-alpha', 'dev-1', 'allow')`);

    return { hashes: await this.hashes() };
  }

  async hashes(): Promise<WorkspaceHashes> {
    const alpha = await (await this.workspaceTarget('ws-alpha')).getWorkspaceCapabilityHash();
    const beta = await (await this.workspaceTarget('ws-beta')).getWorkspaceCapabilityHash();

    return { 'ws-alpha': alpha, 'ws-beta': beta };
  }

  /** The profile read runs schema init first, so an emptied object reports tables present and empty, not absent. */
  async counts(): Promise<Record<string, number>> {
    await this.getProfile(await ownerCaller(this.env));

    const tables = this.ctx.storage.sql.exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).toArray().map((row) => row.name).filter((name) => ACCOUNT_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix)));

    const counts: Record<string, number> = {};

    for (const table of tables) {
      counts[table] = this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`).one().n;
    }

    return counts;
  }

  async reset(): Promise<{ ok: true; workspaces: number }> {
    return this.deleteAccount(await ownerCaller(this.env), RESET_OWNER_ID);
  }

  /** The next sign-in's first request; on a reset account it inserts and the stamp is null. */
  async freshProfile(): Promise<UserProfile | null> {
    const owner = await ownerCaller(this.env);
    await this.ensureProfile(owner, 'owner@probe.local');

    return this.getProfile(owner);
  }
}
