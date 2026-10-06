/**
 * Account deletion on the real UserDO over workerd: only the platform can show `destroy()` takes every
 * table and the same id then addresses a fresh object, and that torn-down workspaces hold no capability.
 * Addressed by the owner's user id, which `deleteAccount` hands to each workspace's `destroyAgent`.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { ownerCaller } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { USER_DO_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import { UserDO } from '../../src/user/user-do';
import { type UserProfile } from '../../src/user/profile';

// Bound under production names: `deleteAccount` reaches workspaces through `env.OrchestratorAgent`.
export * from '../../src/server';




// A Worker module may export only handlers and classes, so fixture values stay module-private.
const RESET_OWNER_ID = '0123456789abcdef0123456789abcdef';

const RESET_WORKSPACES = ['ws-alpha', 'ws-beta'] as const;

type WorkspaceHashes = Record<(typeof RESET_WORKSPACES)[number], string | null>;

interface SeededAccount {
  hashes: WorkspaceHashes;
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

type ClaimTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator, 'claimOwner' | 'getWorkspaceCapabilityHash'>;

/** Workspaces whose teardown is refused; one isolate holds every object of this probe. */
const refusingTeardown = new Set<string>();

/** The production workspace, refusing its teardown when named, as a sandbox that will not stop refuses it. */
export class OrchestratorAgent extends ProductionOrchestrator {
  override async destroyAgent(ownerUserId: string): Promise<{ ok: true }> {
    if (refusingTeardown.has(this.name)) throw new Error('container refused to stop');

    return super.destroyAgent(ownerUserId);
  }
}

const PROBE_METHODS = ['seed', 'counts', 'hashes', 'reset', 'freshProfile', 'refuseTeardownOf', 'pendingDeletes', 'receivedFrom', 'ownerDeleted', 'resetRefused'];

const ACCOUNT_TABLE_PREFIXES = ['user_', 'device_', 'cli_', 'codex_'];

export class AccountResetProbeDO extends UserDO {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof UserDO>[1]) {
    super(ctx, env);

    for (const name of PROBE_METHODS) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...USER_DO_RPC_SURFACE, ...PROBE_METHODS]);
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
      ownerUserId: 'f'.repeat(32), ownerEmail: 'sam@example.test', workspace: 'their-ws', shareId: 'share-1',
    });
    await this.sharesReceived_add(owner, {
      ownerUserId: 'e'.repeat(32), ownerEmail: 'ana@example.test', workspace: 'her-ws', shareId: 'share-2',
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

  async refuseTeardownOf(workspace: string, refuse: boolean): Promise<void> {
    if (refuse) refusingTeardown.add(workspace);
    else refusingTeardown.delete(workspace);
  }

  async pendingDeletes(): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ name: string }>(`SELECT name FROM user_workspaces WHERE delete_pending = 1 ORDER BY name`).toArray().map((row) => row.name);
  }

  /** Who the received shares name. */
  async receivedFrom(): Promise<string[]> {
    return (await this.sharesReceived_list(await ownerCaller(this.env))).map((row) => row.ownerEmail).sort();
  }

  /** Another owner deleted their account: their delete tells each recipient to forget them (`forgetSharesGiven`). */
  async ownerDeleted(ownerUserId: string): Promise<void> {
    await this.sharesReceived_forget(await ownerCaller(this.env), ownerUserId);
  }

  /** A delete a workspace refuses, answered as its thrown chain: a rejection crossing to the runner is reported unhandled. */
  async resetRefused(): Promise<string> {
    try {
      await this.reset();

      return 'deleted';
    } catch (cause) {
      return renderThrownChain({ cause });
    }
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
