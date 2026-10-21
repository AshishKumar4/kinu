/**
 * Account deletion's census on real workerd over the shipped Worker (the privacy policy: deleting an account deletes
 * everything it has). Each store is its production class with one seed and one count of its own; the test reaches each
 * under a `CENSUS_*` binding to the same class, so the objects it seeds and counts are the ones production code reaches
 * as `UserDO`, `OrchestratorAgent`, `MAILBOX` and `ControlPlaneDO`. Every account is this probe's account class, so a
 * card Dana's account sends Priya lands in the object the census reads. Priya Raman's account is deleted; Dana's, at
 * Northwind, shared a board with her.
 */
import { getAgentByName, type AgentContext } from 'agents';
import { ownerCaller, sandboxIdForWorkspace, sandboxPreviewExposures, type WorkspaceOverview } from '@kinu.run/core';
import { initSlateLiveShareTables, initSlateShareTables, SlateLiveShareStore, SlateShareStore } from '@kinu.run/core/slates';
import { internalCaller } from '@kinu.run/core/control-plane';
import { sealRpcSurface } from '@nimbus-sh/fabric/sealed.js';
import { OrchestratorAgent as ProductionOrchestrator } from '../../src/orchestrator';
import { ControlPlaneDO } from '../../src/control-plane/control-plane-do';
import { MailboxDO } from '../../src/mail/mailbox-do';
import { MailNameDO } from '../../src/mail/mailname-do';
import { ORCHESTRATOR_RPC_SURFACE, USER_DO_RPC_SURFACE } from '../../src/rpc-surface';
import { tenantDrive } from '../../src/drive/tenant';
// Mossaic's own names for a tenant's objects and its base shard pool, so a census of the wrong objects cannot pass.
import { vfsShardDOName, vfsUserDOName } from '../../../../third_party/mossaic/worker/core/lib/utils';
import { BASE_POOL_SIZE } from '../../../../third_party/mossaic/shared/constants';
import { MossaicShardDO, MossaicUserDO as DriveUser } from '../../src/drive/mossaic-objects';
import { handleInboundMail } from '../../src/mail/handler';
import { UserDO } from '../../src/user/user-do';
import { shareViewerKey } from '../../src/viewer-pass';
import { accountIdFor } from '../../src/auth/store';

export * from '../../src/server';

/** A person, as a share names its member and the census looks for them. */
interface Person {
  readonly userId: string;
  readonly email: string;
}

const PREVIEW_PORT = 4100;

/** Above Mossaic's inline limit (16 KiB), so the file's bytes are on a shard, not in its user object's row. */
const DRIVE_FILE_BYTES = 40 * 1024;

/** Every row in every table of an object's SQLite, and its KV keys: what it physically keeps. */
function storageRows(ctx: DurableObjectState): number {
  const sql = ctx.storage.sql;

  const tables = sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`)
    .toArray().map((row) => row.name);

  return tables.reduce((sum, name) => sum + sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`).one().n, 0) + [...ctx.storage.kv.list()].length;
}

/** Mossaic's two Drive objects as deployed, each able to say what it physically keeps. */
export class CensusDriveUser extends DriveUser {
  storageRows(): number {
    return storageRows(this.ctx);
  }
}

export class CensusDriveShard extends MossaicShardDO {
  storageRows(): number {
    return storageRows(this.ctx);
  }
}

type ProbeEnv = ConstructorParameters<typeof ProductionOrchestrator>[1];

/** A workspace by name, as the account's own teardown and claims reach it. */
function workspaceNamed(env: ProbeEnv, name: string): Promise<DurableObjectStub<ProductionOrchestrator>> {
  return getAgentByName<ProbeEnv, ProductionOrchestrator>(env.OrchestratorAgent, name);
}

const ACCOUNT_METHODS = ['seedProfile', 'accountsOf', 'runDueWork', 'pushStale', 'deletedAt', 'mailTo', 'driveNames', 'previewKeys', 'signInRows', 'seedPriya', 'seedDana', 'seedSignIn', 'accountCensus', 'sentTo', 'deleteThis', 'signInCensus'];

/** The tables an account holds, by the prefixes `account-reset-probe.ts` counts, and its sent cards. */
const ACCOUNT_TABLE_PREFIXES = ['user_', 'device_', 'cli_', 'codex_', 'share_cards_'];

export class CensusAccountDO extends UserDO {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof UserDO>[1]) {
    super(ctx, env);

    for (const name of ACCOUNT_METHODS) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...USER_DO_RPC_SURFACE, ...ACCOUNT_METHODS]);
  }

  /** The accounts `emails` are on this deployment, by the rule every sign-in mints by. */
  async accountsOf(emails: readonly string[]): Promise<string[]> {
    return await Promise.all(emails.map((email) => accountIdFor(this.env, email)));
  }

  /** Its alarm, run now: the jobs due, a card it sends among them. */
  async runDueWork(): Promise<void> {
    await this.alarm();
  }

  /** An account and nothing else: its profile, as a first sign-in makes it. */
  async seedProfile(person: Person, displayName: string): Promise<void> {
    await this.ensureProfile(await ownerCaller(this.env), person.email, displayName);
  }

  /** Priya's account as she used it: her workspace with a preview, a device, a credential and a file in her Drive. */
  async seedPriya(person: Person): Promise<void> {
    const owner = await ownerCaller(this.env);
    await this.ensureProfile(owner, person.email, 'Priya Raman');
    await this.registerWorkspace(owner, 'priya-notes', 'Priya notes');
    const claim = await (await workspaceNamed(this.env, 'priya-notes')).claimOwner(person.userId);
    await this.ensureWorkspaceCapability('priya-notes', claim.capabilityHash);
    await this.registerDevice(owner, "Priya's laptop");
    await this.setCredential(owner, 'anthropic.bearer', { kind: 'bearer', token: 'sk-priya' });
    await tenantDrive(this.env, person.userId)?.writeFile('/notes.md', new TextEncoder().encode('Webhook signing: rotate the Northwind secret.\n'.repeat(DRIVE_FILE_BYTES / 46 + 1)));
    await sandboxPreviewExposures(this.env.AUTH_KV, sandboxIdForWorkspace('priya-notes')).publish(PREVIEW_PORT, 'preview-token');
  }

  /** Dana's account at Northwind: its workspace, whose overview shares a board with Priya and so sends her a card. */
  async seedDana(priya: Person): Promise<void> {
    const owner = await ownerCaller(this.env);
    await this.ensureProfile(owner, 'dana@northwind.io', 'Dana Whitfield');
    await this.registerWorkspace(owner, 'northwind-api', 'Northwind API');
    const claim = await (await workspaceNamed(this.env, 'northwind-api')).claimOwner(this.name);
    await this.ensureWorkspaceCapability('northwind-api', claim.capabilityHash);

    const overview: WorkspaceOverview = {
      activity: 'idle', decisionsWaiting: 0, hasUpdates: false, latestRun: null, slates: [], awaitsSettings: false,
      shares: [{ kind: 'blueprint', share: 'share-board', slate: 'board', title: 'Webhook board', description: '', createdAt: 1, users: [priya.email] }],
    };

    await this.putWorkspaceOverview(owner, 'northwind-api', overview);
  }

  /** A push from a workspace whose overview still names `priya`, as one cached before her account's deletion would. */
  async pushStale(priya: Person): Promise<void> {
    const overview: WorkspaceOverview = {
      activity: 'idle', decisionsWaiting: 0, hasUpdates: true, latestRun: null, slates: [], awaitsSettings: false,
      shares: [{ kind: 'blueprint', share: 'share-board', slate: 'board', title: 'Webhook board', description: '', createdAt: 1, users: [priya.email] }],
    };

    await this.putWorkspaceOverview(await ownerCaller(this.env), 'northwind-api', overview);
  }

  /** When this account was deleted, if it was: the one thing its object keeps. */
  async deletedAt(): Promise<number | null> {
    const at = this.ctx.storage.kv.get('account:deleted-at');

    return typeof at === 'number' ? at : null;
  }

  /** The deployment's sign-in directory (this class, under its own name): Priya signed up with a password. */
  async seedSignIn(person: Person): Promise<void> {
    await this.builtinRegister(await ownerCaller(this.env), { userId: person.userId, email: person.email, grant: { kind: 'setup' } });
  }

  /** Every account table's rows, after the schema runs again, so an emptied account reads tables present and empty. */
  async accountCensus(): Promise<Record<string, number>> {
    await this.getProfile(await ownerCaller(this.env));
    const sql = this.ctx.storage.sql;

    const tables = sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).toArray()
      .map((row) => row.name).filter((name) => ACCOUNT_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix)));

    return Object.fromEntries(tables.map((table) => [table, sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`).one().n]));
  }

  /** What this account (Dana's) keeps naming `person`: cards sent to them, and their email in its overviews. */
  async sentTo(person: Person): Promise<{ readonly cards: number; readonly overviews: number }> {
    const sql = this.ctx.storage.sql;

    return {
      cards: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM share_cards_sent WHERE recipient_user_id = ?', person.userId).one().n,
      overviews: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM workspace_overviews WHERE instr(lower(overview), ?) > 0', person.email).one().n,
    };
  }

  async deleteThis(): Promise<{ ok: true; workspaces: number }> {
    return this.deleteAccount(await ownerCaller(this.env), this.name);
  }

  async signInCensus(person: Person): Promise<number> {
    return (await this.builtinListAccounts(await ownerCaller(this.env))).filter((account) => account.email === person.email).length;
  }

  /** The names of `tenant`'s Drive objects, as Mossaic names them: its user object, and each base shard. */
  async driveNames(tenant: string): Promise<{ readonly user: string; readonly shards: readonly string[] }> {
    return {
      user: vfsUserDOName('default', tenant),
      shards: Array.from({ length: BASE_POOL_SIZE }, (_, index) => vfsShardDOName('default', tenant, undefined, index)),
    };
  }

  /** The raw KV records `workspace`'s previews are kept under, every family's. */
  async previewKeys(workspace: string): Promise<number> {
    const id = sandboxIdForWorkspace(workspace).toLowerCase();
    let keys = 0;

    for (const family of ['sandbox-preview', 'sandbox-preview-public', 'sandbox-preview-withdrawn']) {
      for (let cursor: string | undefined, more = true; more;) {
        const page = await this.env.AUTH_KV.list({ prefix: `${family}:${id}:`, ...(cursor !== undefined && { cursor }) });

        keys += page.keys.length;
        cursor = page.list_complete ? undefined : page.cursor;
        more = cursor !== undefined;
      }
    }

    return keys;
  }

  /** Rows of the sign-in directory (this class, under its own name) naming `person`, in every table it keeps. */
  async signInRows(person: Person): Promise<number> {
    const sql = this.ctx.storage.sql;

    const tables = sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'builtin_%'`).toArray()
      .map((row) => row.name);

    const names = (value: SqlStorageValue): boolean => typeof value === 'string' && (value.toLowerCase().includes(person.email) || value.includes(person.userId));

    return tables.reduce((sum, name) => sum + sql.exec(`SELECT * FROM "${name}"`).toArray().filter((row) => Object.values(row).some(names)).length, 0);
  }

  /** Mail to `to` as Email Routing hands it to the Worker: the refusals its router answered. */
  async mailTo(to: string, mime: string): Promise<readonly string[]> {
    const raw = new TextEncoder().encode(mime);
    const rejected: string[] = [];

    await handleInboundMail({
      from: 'dana@northwind.io', to, headers: new Headers(), rawSize: raw.byteLength,
      raw: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } }),
      setReject: (reason) => { rejected.push(reason); },
      forward: async () => { throw new Error('the census forwards nothing'); },
      reply: async () => { throw new Error('the census replies to nothing'); },
    }, this.env);

    return rejected;
  }
}

const WORKSPACE_METHODS = ['seedShareWith', 'shareCensus'];

export class CensusWorkspace extends ProductionOrchestrator {
  constructor(ctx: AgentContext, env: ConstructorParameters<typeof ProductionOrchestrator>[1]) {
    super(ctx, env);

    for (const name of WORKSPACE_METHODS) Reflect.deleteProperty(this, name);
    sealRpcSurface(this, [...ORCHESTRATOR_RPC_SURFACE, ...WORKSPACE_METHODS]);
  }

  /** Dana's board shared with Priya: a blueprint share naming her, a live share she edits and opened, and one revoked. */
  async seedShareWith(person: Person): Promise<void> {
    const sql = this.ctx.storage.sql;
    const execRaw = (query: string): void => { sql.exec(query); };

    initSlateShareTables(execRaw);
    initSlateLiveShareTables(execRaw);
    const shares = new SlateShareStore(sql);
    shares.add({ id: 'share-board', slate: 'board', publication: 'pub-1' });
    shares.addUsers('share-board', [{ userId: person.userId, email: person.email }]);
    const live = new SlateLiveShareStore(sql);
    live.add({ id: 'live-board', slate: 'board', visibility: 'users', handle: 'board-handle', grant: { slates: ['board'], members: [] } });
    live.addUsers('live-board', [{ userId: person.userId, email: person.email, role: 'edit' }]);
    live.markEdit('board', person.email);
    // A share Dana revoked once Priya was on it: it keeps no member.
    live.add({ id: 'live-old', slate: 'board', visibility: 'users', handle: 'old-handle', grant: { slates: ['board'], members: [] } });
    live.addUsers('live-old', [{ userId: person.userId, email: person.email }]);
    live.revoke('live-old');
    const view = await shareViewerKey(this.env, 'live-board', person.userId);

    if (view !== null) sql.exec(`INSERT INTO slate_share_views (share, viewer, opens) VALUES ('live-board', ?, 1)`, view);
  }

  /** Rows here naming `person`, by id, email, request subject or view key. */
  async shareCensus(person: Person): Promise<Record<string, number>> {
    const sql = this.ctx.storage.sql;
    const count = (query: string, ...values: string[]): number => sql.exec<{ n: number }>(query, ...values).one().n;
    const view = await shareViewerKey(this.env, 'live-board', person.userId);

    return {
      slate_share_users: count('SELECT COUNT(*) AS n FROM slate_share_users WHERE user_id = ? OR lower(email) = ?', person.userId, person.email),
      slate_share_users_revoked: count(`SELECT COUNT(*) AS n FROM slate_share_users WHERE share_id = 'live-old'`),
      slate_viewer_requests: count('SELECT COUNT(*) AS n FROM slate_viewer_requests WHERE instr(viewer, ?) > 0', person.userId),
      slate_edit_marks: count('SELECT COUNT(*) AS n FROM slate_edit_marks WHERE lower(editor) = ?', person.email),
      slate_share_views: view === null ? 0 : count('SELECT COUNT(*) AS n FROM slate_share_views WHERE viewer = ?', view),
    };
  }
}

/**
 * The mail bucket as Cloudflare's, but with one write the test holds: armed, the next put starts and waits for the
 * test's word. R2 is the mailbox's own external seam, so the test reaches nothing of the mailbox's inside.
 */
class HeldWrite {
  armed = false;
  started = Promise.withResolvers<void>();
  released = Promise.withResolvers<void>();

  bucket(bucket: R2Bucket | undefined): R2Bucket | undefined {
    if (bucket === undefined) return undefined;

    const put: R2Bucket['put'] = async (...args) => {
      if (this.armed) {
        this.armed = false;
        this.started.resolve();
        await this.released.promise;
      }

      return await bucket.put(...args);
    };

    return {
      put, head: bucket.head.bind(bucket), get: bucket.get.bind(bucket), delete: bucket.delete.bind(bucket), list: bucket.list.bind(bucket),
      createMultipartUpload: bucket.createMultipartUpload.bind(bucket), resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
    };
  }
}

export class CensusMailboxDO extends MailboxDO {
  private readonly held: HeldWrite;

  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof MailboxDO>[1]) {
    const held = new HeldWrite();

    super(ctx, { ...env, MAIL_BUCKET: held.bucket(env.MAIL_BUCKET) });
    this.held = held;
  }

  /** The next write to the bucket waits for `releaseWrite`. */
  async holdNextWrite(): Promise<void> {
    this.held.armed = true;
    this.held.started = Promise.withResolvers();
    this.held.released = Promise.withResolvers();
  }

  /** Answers once the held write has started. */
  async writeHeld(): Promise<void> {
    await this.held.started.promise;
  }

  async releaseWrite(): Promise<void> {
    this.held.released.resolve();
  }

  /** Rows in every mail table, and the objects under the account's R2 prefix. */
  async mailCensus(userId: string): Promise<Record<string, number>> {
    const sql = this.ctx.storage.sql;

    const tables = sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'mail_%' OR name LIKE 'outbox_%') ORDER BY name`)
      .toArray().map((row) => row.name).filter((name) => !name.startsWith('mail_fts_'));

    const rows = Object.fromEntries(tables.map((table) => [table, sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`).one().n]));
    const listed = await this.env.MAIL_BUCKET?.list({ prefix: `mail/${userId}/` });

    return { ...rows, r2_objects: listed?.objects.length ?? 0 };
  }
}

/** A mail name, which tells a waiting test when it has been asked to retire. */
export class CensusMailNameDO extends MailNameDO {
  private readonly retiring = Promise.withResolvers<void>();

  override async retire(userId: string): Promise<void> {
    this.retiring.resolve();
    await super.retire(userId);
  }

  /** Answers once `retire` has been called on this name. */
  async whenRetired(): Promise<void> {
    await this.retiring.promise;
  }
}

/** The audit's text columns, any of which may name an account. */
const AUDIT_COLUMNS = ['actor_user', 'actor_email', 'target', 'detail'] as const;

export class CensusControlPlaneDO extends ControlPlaneDO {
  /** Priya in the fleet's index: her user and workspace rows, her feedback with its screenshot, an operator's audit
   *  row about her workspace, and her star, report and install on Dana's listed board. */
  async seedPerson(person: Person): Promise<void> {
    const caller = await internalCaller(this.env);
    await this.observeUser(caller, { userId: person.userId, email: person.email, displayName: 'Priya Raman' });
    await this.observeWorkspace(caller, { userId: person.userId, name: 'priya-notes', displayName: 'Priya notes' });

    const { id } = await this.recordFeedback(caller, {
      id: 'feedback-priya', createdAt: 1, userId: person.userId, email: person.email, note: 'The board is slow', route: '/w/priya-notes', workspace: 'priya-notes', bytes: 4,
    });

    await this.env.FEEDBACK_BUCKET?.put(`feedback/${person.userId}/${id}.png`, new Uint8Array([137, 80, 78, 71]));
    this.ctx.storage.sql.exec(`INSERT INTO cp_audit (id, at, actor_email, actor_user, operation, target_kind, target, outcome, detail)
      VALUES ('audit-1', 1, 'ops@kinu.run', 'operator', 'workspace.restart', 'workspace', ?, 'ok', ?)`, `${person.userId}/priya-notes`, `asked by ${person.email}`);

    await this.gallerySync(caller, {
      listed: true, share: 'live-board', workspace: 'northwind-api', slate: 'board', handle: 'board-handle', url: 'https://kinu.run/s/board-handle',
      card: { title: 'Webhook board', line: 'Northwind webhook deliveries', category: 'developer', ownerName: 'Dana Whitfield', picture: null, viewers: 1 },
    });
    await this.galleryMark(caller, person, { kind: 'star', workspace: 'northwind-api', slate: 'board', on: true });
    await this.galleryMark(caller, person, { kind: 'report', workspace: 'northwind-api', slate: 'board', reason: 'spam' });
    await this.exploreInstalled(caller, { kind: 'app', workspace: 'northwind-api', item: 'board', userId: person.userId });
  }

  /** Rows here naming `person` (in the audit, by id, email or workspace), and objects under their feedback prefix. */
  async controlCensus(person: Person): Promise<Record<string, number>> {
    const sql = this.ctx.storage.sql;
    const count = (query: string, ...values: string[]): number => sql.exec<{ n: number }>(query, ...values).one().n;
    const listed = await this.env.FEEDBACK_BUCKET?.list({ prefix: `feedback/${person.userId}/` });
    const audit = sql.exec<Record<(typeof AUDIT_COLUMNS)[number], string>>(`SELECT ${AUDIT_COLUMNS.join(', ')} FROM cp_audit`).toArray();
    const names = (text: string): boolean => [person.userId, person.email, 'priya-notes'].some((name) => text.includes(name));

    return {
      cp_users: count('SELECT COUNT(*) AS n FROM cp_users WHERE user_id = ? OR email = ?', person.userId, person.email),
      cp_workspaces: count('SELECT COUNT(*) AS n FROM cp_workspaces WHERE user_id = ?', person.userId),
      cp_feedback: count('SELECT COUNT(*) AS n FROM cp_feedback WHERE user_id = ? OR email = ?', person.userId, person.email),
      cp_audit_naming: audit.filter((row) => AUDIT_COLUMNS.some((column) => names(row[column]))).length,
      cp_audit_rows: audit.length,
      gallery_stars: count('SELECT COUNT(*) AS n FROM gallery_stars WHERE email = ?', person.email),
      gallery_installs: count('SELECT COUNT(*) AS n FROM gallery_installs WHERE user_id = ?', person.userId),
      feedback_objects: listed?.objects.length ?? 0,
    };
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
