/**
 * Per-agent layout in the one global view per workspace: uid/gid/mode on shared inodes, never a per-agent filesystem
 * or mount table, since shell and file-RPC planes resolve every path alike. Homes are 0o755 for the grader and
 * merge-back; tmp is 0o700. Both planes act as the agent's credential, or its own tool writes get `EACCES`.
 */

import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { Effect } from 'effect';
import { settleSync } from '../obs/effect';
import { CRED_SESSION_USER, type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { IdentityChangePolicy } from '@nimbus-sh/core/workspace';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { VfsRemoval } from '@nimbus-sh/core/vfs/vfs.js';
import { removeWhole } from './mounts';
import * as v from 'valibot';
import { SOUL_FILE, SOUL_PATH } from '../identity/soul';
import { parseActorKey } from '../identity/actor-key';
import { isSubagentOrigin, type WorkspaceActor } from '../identity/workspace-actors';
import { SHARED_ROOTS, WORKSPACE_ROOT } from './workspace-path';

/** Its home is {@link WORKSPACE_ROOT}. */
export const MAIN_AGENT = 'main';

/**
 * A share's viewer's home and identity row (`execution/viewer-principal.ts`): a usable home name, and never an agent's,
 * whose name is a slug without `_`.
 */
export const VIEWER_HOME_NAME = 'share_viewer';

/** Owner writes; everyone reads and traverses. */
const AGENT_HOME_MODE = 0o755;


/** Owner only, and discarded with the agent. */
const AGENT_TMP_MODE = 0o700;

/** The substrate's session identity; an unnamed exec runs as it. */
export const SESSION_UID = 1000;

/** Allocated agent uids start here — clear of uid 0 and {@link SESSION_UID}. */
export const AGENT_UID_FLOOR = 2000;

const WORKSPACE_GID = SESSION_UID;

/** The project tree's group ({@link shareProjectTree}): its owner's and a share's viewer's, no other agent's. Clear of the
 *  session's group and of every agent's own, which start at {@link AGENT_UID_FLOOR}. */
export const PROJECT_GID = 1001;

/**
 * The session user with the project's group, where Kinu hands Nimbus the owner's credential (the workspace agent's
 * session). Nimbus's own session user is a frozen `{1000, 1000, [1000]}` (Nimbus ask 73), so the owner's unnamed shell
 * still cannot write a file a share's viewer made in the project.
 */
export const PROJECT_OWNER_CRED: VfsCred = { ...CRED_SESSION_USER, groups: [SESSION_UID, PROJECT_GID] };

const SHARED_DIRECTORY_MODE = 0o2775;

const SHARED_DEFAULT_ACL = 0o775;

/**
 * The first character excludes `-` so no home reads as a CLI flag; derived
 * names are prefixed so ids keep their case and the mapping stays injective.
 */
const AGENT_NAME_RE = /^[a-z0-9][A-Za-z0-9_-]{0,95}$/;

/** Where this agent's own writes belong. */
export function agentHome(agentName: string): string {
  if (agentName === MAIN_AGENT) return WORKSPACE_ROOT;

  return settleSync(Effect.map(validAgentName(agentName), (name) => `/home/${name}`));
}

/** Durable payloads belong to this actor, not the publicly traversable home. */
export function agentArtifactDirectory(home: string): string {
  return `${home}/.kinu/context`;
}

/** Logical `/tmp/<agent>` path; the confinement registry gets the storage key instead. */
export function agentTmpRoot(agentName: string): string {
  return settleSync(Effect.map(validAgentName(agentName), (name) => `/tmp/${name}`));
}

/** Revalidated here: the roster's rule and this one are checked by different callers. */
function subagentAgentName(subagentName: string): Effect.Effect<string> {
  return validAgentName(`sub-${subagentName}`);
}

/** Unsafe ids are refused, not escaped: grader and merge-back must derive the same home. */
function headAgentName(headId: string): Effect.Effect<string> {
  return validAgentName(`head-${headId}`);
}

/**
 * An actor's home, from its storage key and kind; the workspace's own agent's is {@link MAIN_AGENT}. The one
 * derivation creation, the file plane and retirement share. A hire keyed by its own name, one no other actor of the
 * workspace has had, lives under it (`/home/fix-health-check`); any other's key is its id, behind a prefix.
 */
export function actorHomeName(record: Pick<WorkspaceActor, 'origin' | 'name' | 'storageKey'>): string {
  if (record.origin === 'system') return MAIN_AGENT;

  if (isSubagentOrigin(record.origin) && record.storageKey === record.name) return settleSync(validAgentName(record.name));
  const { id } = parseActorKey(record.storageKey);

  return settleSync(isSubagentOrigin(record.origin) ? subagentAgentName(id) : headAgentName(id));
}

/** Storage key; only the confinement boundary uses it. */
function agentTmpStorageRoot(agentName: string): Effect.Effect<string> {
  return Effect.map(validAgentName(agentName), (name) => `tmp/${name}`);
}

function validAgentName(agentName: string): Effect.Effect<string> {
  return AGENT_NAME_RE.test(agentName)
    ? Effect.succeed(agentName)
    : Effect.die(new Error(
      `'${agentName}' is not a usable agent name: a home is a directory under /home, so a name is `
      + 'lowercase alphanumeric with - and _, at most 96 characters, and never a path.',
    ));
}

/** `gid` equals `uid`, so group membership never grants a sibling's home. */
export interface AgentIdentity {
  readonly uid: number;
  readonly gid: number;
}

/** {@link AgentIdentity} as the substrate's per-call credential. */
export function agentCred(identity: AgentIdentity): VfsCred {
  const groups = identity.gid === WORKSPACE_GID ? [identity.gid] : [identity.gid, WORKSPACE_GID];

  return { uid: identity.uid, gid: identity.gid, groups, umask: 0o022 };
}

const IDENTITY_TABLE = 'kinu_agent_identity';

/** Made on first use (a workspace's boot, a facet's first home); a repair's trial reads its shape from here too. */
export function ensureIdentityTable(sql: SqlDatabase): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${IDENTITY_TABLE} (
       agent_name TEXT PRIMARY KEY,
       uid        INTEGER NOT NULL UNIQUE
     )`,
  );
}

/**
 * Durable uid, allocated once; UNIQUE `uid` makes concurrent inserts converge.
 */
export function agentIdentity(sql: SqlDatabase, agentName: string): AgentIdentity {
  return settleSync(Effect.gen(function* () {
    if (agentName === MAIN_AGENT) return { uid: SESSION_UID, gid: SESSION_UID };
    yield* validAgentName(agentName);
    ensureIdentityTable(sql);
    // `WHERE true` is required: SQLite cannot parse an INSERT..SELECT upsert without it.
    sql.exec(
      `INSERT INTO ${IDENTITY_TABLE} (agent_name, uid)
       SELECT ?, next.uid
         FROM (SELECT COALESCE(MAX(uid), ?) + 1 AS uid FROM ${IDENTITY_TABLE}) AS next
        WHERE true
       ON CONFLICT(agent_name) DO NOTHING`,
      agentName,
      AGENT_UID_FLOOR - 1,
    );
    const identity = allocatedAgentIdentity(sql, agentName);

    if (!identity) return yield* Effect.die(new Error(`agent identity for '${agentName}' did not persist`));

    return identity;
  }));
}

/** Reads only; never allocates. */
/** The agent given `uid` as its own ({@link agentIdentity}); null for a uid below the agents' (root, the session user). */
export function agentNameOfUid(sql: SqlDatabase, uid: number): string | null {
  if (uid < AGENT_UID_FLOOR) return null;
  const [row] = [...sql.exec(`SELECT agent_name FROM ${IDENTITY_TABLE} WHERE uid = ?`, uid)];

  return row === undefined ? null : v.parse(v.string(), row.agent_name);
}

function allocatedAgentIdentity(sql: SqlDatabase, agentName: string): AgentIdentity | null {
  const [row] = [...sql.exec(`SELECT uid FROM ${IDENTITY_TABLE} WHERE agent_name = ?`, agentName)];

  return row ? { uid: Number(row.uid), gid: Number(row.uid) } : null;
}

/** A home's lifecycle, as `SqliteVFS.as(CRED_KERNEL)`. */
export interface HomeRootVfs {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  chown(path: string, uid: number | null, gid: number | null): void;
  chmod(path: string, mode: number): void;
  exists(path: string): boolean;
  stat(path: string): { readonly uid: number; readonly gid: number; readonly mode: number };
  removeRecursive(path: string): VfsRemoval | void;
}

/** Registers a confined principal against its physical storage root. */
export interface TmpConfiner {
  confinePrincipal(uid: number, tmpStorageRoot: string): void;
  releasePrincipal(uid: number): void;
}

interface AgentDir {
  readonly path: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

/** In creation order. */
function agentHomeLayout(agentName: string, identity: AgentIdentity): readonly AgentDir[] {
  return [
    { path: agentHome(agentName), uid: identity.uid, gid: identity.gid, mode: AGENT_HOME_MODE },
    { path: agentTmpRoot(agentName), uid: identity.uid, gid: identity.gid, mode: AGENT_TMP_MODE },
    { path: `${agentHome(agentName)}/.kinu`, uid: identity.uid, gid: identity.gid, mode: 0o700 },
    { path: agentArtifactDirectory(agentHome(agentName)), uid: identity.uid, gid: identity.gid, mode: 0o700 },
  ];
}

/** Host-side: only uid 0 may chown. Runs every wake, so writes only what moved. The project tree's own group and mode are
 *  its creation's ({@link shareProjectTree}) and then its owner's: only its owner is settled. */
export function provisionAgentHome(root: HomeRootVfs, agentName: string, identity: AgentIdentity): string {
  for (const dir of agentHomeLayout(agentName, identity)) {
    if (!root.exists(dir.path)) root.mkdir(dir.path, { recursive: true });
    const held = root.stat(dir.path);
    const project = dir.path === WORKSPACE_ROOT;
    const gid = project ? held.gid : dir.gid;

    if (held.uid !== dir.uid || held.gid !== gid) root.chown(dir.path, dir.uid, gid);

    if (!project && (held.mode & 0o7777) !== dir.mode) root.chmod(dir.path, dir.mode);
  }

  return agentHome(agentName);
}

/** Setgid, and sticky: a viewer may write the project's root, so without it the viewer could remove or rename what it did
 *  not make there, `SOUL.md` and `.kinu` among them (Nimbus enforces the sticky bit on unlink and rename). */
const PROJECT_MODE = 0o3775;

const PROJECT_DEFAULT_ACL = 0o775;

/**
 * The project tree ({@link WORKSPACE_ROOT}) as a new workspace makes it: its owner's, setgid to {@link PROJECT_GID}, with a
 * default ACL that keeps what its owner or a share's viewer makes there group-writable, so each writes the other's (the
 * owner, 2026-10-19: a share's commands write "your project too, as today"). `.kinu` and `SOUL.md` keep their own owners
 * and modes; another agent reads the project as before.
 */
function shareProjectTree(kernel: Pick<CredentialedVfs, 'chown' | 'chmod' | 'setDefaultAcl'>): void {
  kernel.chown(WORKSPACE_ROOT, SESSION_UID, PROJECT_GID);
  kernel.chmod(WORKSPACE_ROOT, PROJECT_MODE);
  kernel.setDefaultAcl(WORKSPACE_ROOT, PROJECT_DEFAULT_ACL);
}

/**
 * Main's home, which is the project tree: provisioned as every agent's, and shared ({@link shareProjectTree}) by the call
 * that makes its `.kinu`, which is the workspace's creation. An older workspace already has one and keeps its tree as it
 * was: no migration. Read from the tree itself, so no counter or reset of one can share an old tree or skip a new one; an
 * owner who deletes `.kinu` has the tree shared at the next boot, as a new one, and a boot that dies between the two
 * leaves it unshared.
 */
export function provisionProjectHome(root: HomeRootVfs & Pick<CredentialedVfs, 'setDefaultAcl'>, identity: AgentIdentity): string {
  const created = !root.exists(`${WORKSPACE_ROOT}/.kinu`);
  const home = provisionAgentHome(root, MAIN_AGENT, identity);

  if (created) shareProjectTree(root);

  return home;
}

/** Nimbus seeds the configured HOME (env.HOME is {@link WORKSPACE_ROOT}); `/home` holds every agent's, so root owns it. */
export function settleWorkspaceRoot(kernel: Pick<CredentialedVfs, 'stat' | 'chown' | 'chmod'>): void {
  const homes = kernel.stat('/home');

  if (homes.uid !== 0 || homes.gid !== 0 || (homes.mode & 0o7777) !== 0o755) {
    kernel.chown('/home', 0, 0);
    kernel.chmod('/home', 0o755);
  }
}

export type SoulVfs = Pick<CredentialedVfs, 'readdir' | 'lstat' | 'writeFile' | 'unlink' | 'chown' | 'chmod'>;

/** Main owns SOUL.md and the workspace group writes it: every agent of the workspace carries that group. */
const SOUL_MODE = 0o664;

/** SOUL.md, with `content` where given, as an ordinary file of the workspace that every agent of it edits. */
export function provisionWorkspaceSoul(kernel: SoulVfs, content?: string | Uint8Array): void {
  const present = (): boolean => kernel.readdir(WORKSPACE_ROOT).some((entry) => entry.name === SOUL_PATH);

  return settleSync(Effect.gen(function* () {
    // Written as uid 0, so never through an entry an agent put there: a link is replaced by the file, a directory refused.
    if (content !== undefined) {
      const there = present() ? kernel.lstat(SOUL_FILE).type : null;

      if (there === 'symlink') kernel.unlink(SOUL_FILE);
      else if (there !== null && there !== 'file') return yield* Effect.fail(new VfsError('EISDIR', `${SOUL_FILE} is a ${there}, not the workspace's SOUL.md`, SOUL_FILE));
      kernel.writeFile(SOUL_FILE, content);
    }

    if (!present()) return;
    const entry = kernel.lstat(SOUL_FILE);

    // A directory or link an agent left there is its own; only the file is shared.
    if (entry.type !== 'file') return;

    if (entry.uid !== SESSION_UID || entry.gid !== WORKSPACE_GID) kernel.chown(SOUL_FILE, SESSION_UID, WORKSPACE_GID);

    if ((entry.mode & 0o7777) !== SOUL_MODE) kernel.chmod(SOUL_FILE, SOUL_MODE);
  }));
}

type SharedRootVfs = Pick<CredentialedVfs, 'exists' | 'mkdir' | 'stat' | 'chown' | 'chmod' | 'getDefaultAcl' | 'setDefaultAcl'>;

/**
 * Each of the workspace's {@link SHARED_ROOTS}: kernel-owned, group-shared, setgid, and registered with Nimbus as a shared
 * directory (`register`: once per engine boot, from trusted host init).
 */
export function settleSharedRoots(kernel: SharedRootVfs, register: (path: string) => void): void {
  for (const path of SHARED_ROOTS) {
    if (!kernel.exists(path)) kernel.mkdir(path);

    const root = kernel.stat(path);

    // What Nimbus asks of a shared directory before it registers one: root's, setgid, and a default ACL
    // (`setfacl -d -m g::rwx`) that lets the group write what a member makes there.
    const shared = root.uid === 0 && root.gid === WORKSPACE_GID && (root.mode & 0o7777) === SHARED_DIRECTORY_MODE
      && kernel.getDefaultAcl(path) === SHARED_DEFAULT_ACL;

    if (!shared) {
      kernel.chown(path, 0, WORKSPACE_GID);
      kernel.chmod(path, SHARED_DIRECTORY_MODE);
      kernel.setDefaultAcl(path, SHARED_DEFAULT_ACL);
    }

    register(path);
  }
}

/** Make `/tmp` resolve to this agent's own tmp for this agent's uid. */
export function confineAgentTmp(
  confiner: TmpConfiner,
  agentName: string,
  identity: AgentIdentity,
): string {
  return settleSync(Effect.gen(function* () {
    const tmpRoot = agentTmpRoot(agentName);
    confiner.confinePrincipal(identity.uid, yield* agentTmpStorageRoot(agentName));

    return tmpRoot;
  }));
}

/**
 * Remove the agent's bytes and `/tmp` rewrite; the uid row is kept so a
 * returning agent gets the same identity. Idempotent.
 */
export function releaseAgentHome(
  root: HomeRootVfs,
  confiner: TmpConfiner,
  sql: SqlDatabase,
  agentName: string,
): void {
  return settleSync(Effect.gen(function* () {
    if (agentName === MAIN_AGENT) return yield* Effect.die(new Error('the workspace agent has no home to release'));

    for (const path of [agentHome(agentName), agentTmpRoot(agentName)]) {
      // Whole, or the release stops: a principal released over files it still owns hands them to its uid's next holder.
      if (root.exists(path)) removeWhole(root, path);
    }

    const identity = allocatedAgentIdentity(sql, agentName);

    if (identity) confiner.releasePrincipal(identity.uid);
  }));
}

/**
 * Re-register `/tmp` rewrites after the in-memory registry is recreated;
 * an existing tmp dir marks a live agent.
 */
export function restoreAgentTmpConfinements(
  sql: SqlDatabase,
  root: Pick<HomeRootVfs, 'exists'>,
  confiner: TmpConfiner,
): number {
  return settleSync(Effect.gen(function* () {
    ensureIdentityTable(sql);
    let restored = 0;

    for (const row of sql.exec(`SELECT agent_name, uid FROM ${IDENTITY_TABLE}`)) {
      // This module is the column's only writer; anything else is refused, not guessed.
      const agentName = v.parse(v.string(), row.agent_name);

      if (!root.exists(agentTmpRoot(agentName))) continue;
      confiner.confinePrincipal(Number(row.uid), yield* agentTmpStorageRoot(agentName));
      restored += 1;
    }

    return restored;
  }));
}

/**
 * The workspace's answer to a process taking another uid (Nimbus asks it before every such process, by `sudo`, `su` or
 * any command's runAs): a process running as the viewer takes none, since another uid is its owner's files and
 * processes. Every other process changes as before.
 */
export function viewerStaysItself(sql: SqlDatabase): IdentityChangePolicy {
  return (from) => agentNameOfUid(sql, from.uid) !== VIEWER_HOME_NAME;
}
