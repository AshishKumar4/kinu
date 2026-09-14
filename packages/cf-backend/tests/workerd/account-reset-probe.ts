/**
 * Account deletion on the REAL UserDO over real workerd.
 *
 * WHAT ONLY THIS CAN PROVE. `unit-account-delete.test.ts` drives the same
 * method over bun:sqlite with a stand-in SDK, so it can say the sweeps ran and
 * the harness's `deleteAll` emptied its database. Two facts are the platform's
 * to state and nothing in bun can state them: that the SDK's `destroy()` really
 * takes every table of a SQLite-backed object and that the object addressed by
 * the same id afterwards is a FRESH one — empty tables, no profile, no
 * onboarding stamp — rather than the aborted one revived over its old rows.
 * And that the workspace objects the delete tore down answer the owner's next
 * question with no capability at all, which is what a real teardown leaves.
 *
 * The probe is the production class plus four fixture methods, sealed through
 * the production seal — the same shape user-socket-probe.ts uses — so every
 * call the test makes crosses the real RPC boundary into the real object.
 * The object is addressed BY THE OWNER'S USER ID, because `deleteAccount`
 * hands that id to each workspace's `destroyAgent`, which compares it to the
 * owner the workspace claimed.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { ownerCaller } from '@kinu.run/core';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { USER_DO_RPC_SURFACE, sealRpcSurface } from '../../src/rpc-surface';
import { UserDO, type UserProfile } from '../../src/user/user-do';

// Bound under their production names so the auxiliary worker's durableObjects
// carry the classes themselves: `deleteAccount` reaches each workspace through
// `env.OrchestratorAgent`, exactly as production does.
export { UserDO } from '../../src/user/user-do';

export { OrchestratorAgent } from '../../src/orchestrator';

// A Worker module may export only handlers and classes, so the fixture values
// stay module-private and the test spells the owner id for itself.
const RESET_OWNER_ID = '0123456789abcdef0123456789abcdef';

const RESET_WORKSPACES = ['ws-alpha', 'ws-beta'] as const;

type WorkspaceHashes = Record<(typeof RESET_WORKSPACES)[number], string | null>;

interface SeededAccount {
  hashes: WorkspaceHashes;
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

type ClaimTarget = Pick<Fetcher, 'fetch'> & Pick<ProductionOrchestrator, 'claimOwner' | 'getWorkspaceCapabilityHash'>;

/** The tables the account writes, by the prefixes the user schema uses. */
const ACCOUNT_TABLE_PREFIXES = ['user_', 'device_', 'cli_', 'codex_'];

export class AccountResetProbeDO extends UserDO {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof UserDO>[1]) {
    super(ctx, env);

    for (const name of ['seed', 'counts', 'hashes', 'reset', 'freshProfile']) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...USER_DO_RPC_SURFACE, 'seed', 'counts', 'hashes', 'reset', 'freshProfile']);
  }

  private async workspaceTarget(workspace: string): Promise<ClaimTarget> {
    // SAFETY: the durableObjects binding declares the production
    // OrchestratorAgent under its own name, and every picked member is one the
    // production class declares; the plain fetch pick first is the narrowing
    // slate-durability-probe applies for the same TS2589 reason.
    const raw: Pick<Fetcher, 'fetch'> = await getAgentByName<ProbeEnv, ProductionOrchestrator>(
      this.env.OrchestratorAgent as DurableObjectNamespace<ProductionOrchestrator>, workspace,
    );

    // SAFETY: `raw` is the stub for the bound production class, which declares
    // both members ClaimTarget names.
    return raw as ClaimTarget;
  }

  /** A lived-in account: two owned workspaces with minted capabilities, a
   *  blueprint someone shared here, an MCP server, a credential and a device
   *  grant — one row in every store the delete has to empty. */
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

  /** The capability each workspace object holds, asked of the object itself. */
  async hashes(): Promise<WorkspaceHashes> {
    const alpha = await (await this.workspaceTarget('ws-alpha')).getWorkspaceCapabilityHash();
    const beta = await (await this.workspaceTarget('ws-beta')).getWorkspaceCapabilityHash();

    return { 'ws-alpha': alpha, 'ws-beta': beta };
  }

  /** Row counts of every account table that exists. The profile read first is
   *  what runs the schema init on a fresh activation, so an emptied object
   *  reports its tables as present and empty rather than as absent. */
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

  /** What the next sign-in's first request does: upsert the profile, then
   *  read it. On a reset account that is an insert, and the stamp is null. */
  async freshProfile(): Promise<UserProfile | null> {
    const owner = await ownerCaller(this.env);
    await this.ensureProfile(owner, 'owner@probe.local');

    return this.getProfile(owner);
  }
}
