/**
 * Per-agent layout in the one global view per workspace: separation is
 * uid/gid/mode on shared inodes, never a per-agent filesystem or mount table
 * (shell and file-RPC planes must resolve every path identically).
 * Homes are 0o755 so the grader and merge-back can read them; tmp is 0o700.
 * Both planes act as the agent's credential, or its own tool writes get `EACCES`.
 */

import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import * as v from 'valibot';
import { WORKSPACE_ROOT } from './workspace-path';

/** Its home is {@link WORKSPACE_ROOT}: `/home/user` is the vendored substrate's own `$HOME`. */
export const MAIN_AGENT = 'main';

/** Owner writes; everyone reads and traverses. */
export const AGENT_HOME_MODE = 0o755;

/** Owner only, and discarded with the agent. */
export const AGENT_TMP_MODE = 0o700;

/** The substrate's session identity; an unnamed exec runs as it. */
export const SESSION_UID = 1000;

/** Allocated agent uids start here — clear of uid 0 and {@link SESSION_UID}. */
export const AGENT_UID_FLOOR = 2000;

/**
 * The first character excludes `-` so no home reads as a CLI flag; derived
 * names are prefixed so ids keep their case and the mapping stays injective.
 */
const AGENT_NAME_RE = /^[a-z0-9][A-Za-z0-9_-]{0,95}$/;

/** Where this agent's own writes belong. */
export function agentHome(agentName: string): string {
  if (agentName === MAIN_AGENT) return WORKSPACE_ROOT;
  assertAgentName(agentName);

  return `/home/${agentName}`;
}

/** Durable payloads belong to this actor, not the publicly traversable home. */
export function agentArtifactDirectory(home: string): string {
  return `${home}/.kinu/context`;
}

/** Logical `/tmp/<agent>` path; the confinement registry gets the storage key instead. */
export function agentTmpRoot(agentName: string): string {
  assertAgentName(agentName);

  return `/tmp/${agentName}`;
}

/** Revalidated here: the roster's rule and this one are checked by different callers. */
export function subordinateAgentName(subordinateName: string): string {
  const agentName = `sub-${subordinateName}`;
  assertAgentName(agentName);

  return agentName;
}

/** Unsafe ids are refused, not escaped: grader and merge-back must derive the same home. */
export function headAgentName(headId: string): string {
  const agentName = `head-${headId}`;
  assertAgentName(agentName);

  return agentName;
}

/** Storage key; only the confinement boundary uses it. */
function agentTmpStorageRoot(agentName: string): string {
  assertAgentName(agentName);

  return `tmp/${agentName}`;
}

function assertAgentName(agentName: string): void {
  if (!AGENT_NAME_RE.test(agentName)) {
    throw new Error(
      `'${agentName}' is not a usable agent name: a home is a directory under /home, so a name is `
      + 'lowercase alphanumeric with - and _, at most 96 characters, and never a path.',
    );
  }
}

/** `gid` equals `uid`, so group membership never grants a sibling's home. */
export interface AgentIdentity {
  readonly uid: number;
  readonly gid: number;
}

/** {@link AgentIdentity} as the substrate's per-call credential. */
export function agentCred(identity: AgentIdentity): VfsCred {
  return { uid: identity.uid, gid: identity.gid, groups: [identity.gid], umask: 0o022 };
}

const IDENTITY_TABLE = 'kinu_agent_identity';

function ensureIdentityTable(sql: SqlDatabase): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${IDENTITY_TABLE} (
       agent_name TEXT PRIMARY KEY,
       uid        INTEGER NOT NULL UNIQUE,
       gid        INTEGER NOT NULL
     )`,
  );
}

/**
 * Durable uid, allocated once; UNIQUE `uid` makes concurrent inserts converge.
 */
export function agentIdentity(sql: SqlDatabase, agentName: string): AgentIdentity {
  if (agentName === MAIN_AGENT) return { uid: SESSION_UID, gid: SESSION_UID };
  assertAgentName(agentName);
  ensureIdentityTable(sql);
  // `WHERE true` is required: SQLite cannot parse an INSERT..SELECT upsert without it.
  sql.exec(
    `INSERT INTO ${IDENTITY_TABLE} (agent_name, uid, gid)
     SELECT ?, next.uid, next.uid
       FROM (SELECT COALESCE(MAX(uid), ?) + 1 AS uid FROM ${IDENTITY_TABLE}) AS next
      WHERE true
     ON CONFLICT(agent_name) DO NOTHING`,
    agentName,
    AGENT_UID_FLOOR - 1,
  );
  const identity = allocatedAgentIdentity(sql, agentName);

  if (!identity) throw new Error(`agent identity for '${agentName}' did not persist`);

  return identity;
}

/** Reads only; never allocates. */
function allocatedAgentIdentity(sql: SqlDatabase, agentName: string): AgentIdentity | null {
  const [row] = [...sql.exec(`SELECT uid, gid FROM ${IDENTITY_TABLE} WHERE agent_name = ?`, agentName)];

  return row ? { uid: Number(row.uid), gid: Number(row.gid) } : null;
}

/** Root-credentialled surface a home's lifecycle needs; satisfied by `SqliteVFS.as(CRED_KERNEL)`. */
export interface HomeRootVfs {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  chown(path: string, uid: number | null, gid: number | null): void;
  chmod(path: string, mode: number): void;
  exists(path: string): boolean;
  removeRecursive(path: string): number;
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

/**
 * Host-side create, chown, then chmod: only uid 0 may chown. Idempotent.
 */
export function provisionAgentHome(root: HomeRootVfs, agentName: string, identity: AgentIdentity): string {
  for (const dir of agentHomeLayout(agentName, identity)) {
    root.mkdir(dir.path, { recursive: true });
    root.chown(dir.path, dir.uid, dir.gid);
    root.chmod(dir.path, dir.mode);
  }

  return agentHome(agentName);
}

/** Make `/tmp` resolve to this agent's own tmp for this agent's uid. */
export function confineAgentTmp(
  confiner: TmpConfiner,
  agentName: string,
  identity: AgentIdentity,
): string {
  const tmpRoot = agentTmpRoot(agentName);
  confiner.confinePrincipal(identity.uid, agentTmpStorageRoot(agentName));

  return tmpRoot;
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
  if (agentName === MAIN_AGENT) throw new Error('the workspace agent has no home to release');

  for (const path of [agentHome(agentName), agentTmpRoot(agentName)]) {
    if (root.exists(path)) root.removeRecursive(path);
  }

  const identity = allocatedAgentIdentity(sql, agentName);

  if (identity) confiner.releasePrincipal(identity.uid);
}

/**
 * Re-register `/tmp` rewrites after the in-memory registry is recreated;
 * an existing tmp dir marks a live agent. Returns the count restored.
 */
export function restoreAgentTmpConfinements(
  sql: SqlDatabase,
  root: Pick<HomeRootVfs, 'exists'>,
  confiner: TmpConfiner,
): number {
  ensureIdentityTable(sql);
  let restored = 0;

  for (const row of sql.exec(`SELECT agent_name, uid FROM ${IDENTITY_TABLE}`)) {
    // This module is the column's only writer; anything else is refused, not guessed.
    const agentName = v.parse(v.string(), row.agent_name);

    if (!root.exists(agentTmpRoot(agentName))) continue;
    confiner.confinePrincipal(Number(row.uid), agentTmpStorageRoot(agentName));
    restored += 1;
  }

  return restored;
}
