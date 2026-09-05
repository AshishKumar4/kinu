/**
 * The global view's layout: where each agent's tree lives, who owns it, and who
 * may write it.
 *
 * ONE global view per workspace. Every agent — the workspace agent, an
 * exploration head, a swarm node — sees the same filesystem at the same paths,
 * and separation between them is uid/gid/mode on real inodes rather than a
 * separate filesystem each. That choice is what keeps the read window open: the
 * regression recorded at `cf-backend/tests/unit-head-fork.test.ts:4-8` was a
 * subagent handed a freshly-created EMPTY filesystem, so an agent asked to
 * research a codebase the user had cloned could see none of it. Isolation
 * without a read window is a regression, and a boundary made of permissions
 * inside one view cannot reproduce it — there is no second filesystem to be
 * empty.
 *
 * There is deliberately NO mount table here, for the reason
 * `vfs/nimbus-workspace.ts:19-26` already states and `83bf4bbc` measured: the
 * shell plane and the file-RPC plane reach the tree by different routes, so a
 * per-agent rewrite installed at the mount layer moves one and leaves the
 * other, which is one path meaning two files. Homes need no mount at all —
 * they are ordinary directories in the one tree, so both planes resolve them
 * identically by construction. `/tmp` is likewise per-credential BELOW both
 * planes, in `SqliteVFS.resolvePath`; {@link confineAgentTmp} only registers a
 * principal there and never re-implements it.
 *
 * Modes, and why they are not private:
 *
 *   home  0o755  owner writes, everyone reads and traverses
 *   tmp   0o700  owner only, and it dies with the agent
 *
 * `0o700` on a home would rebuild the empty-filesystem regression at node
 * granularity, because two readers that are not the node must reach it: the
 * grader, which scores a node on what its home contains and does not run as
 * that node, and merge-back, which copies a winner's diff out. Siblings can
 * therefore read each other's homes. That is intended — everything outside an
 * agent's own home is read/exec-only, which means readable — and it does not
 * compromise search independence, because independence is a property of what
 * reaches a node's CONTEXT, not of what it could theoretically open.
 *
 * OWNER MEANS THE AGENT ON BOTH PLANES, and that is a requirement rather than a
 * remark. An agent reaches this tree through its commands and through its file
 * tools, and a file plane that acts as the session user would refuse the agent's
 * own tool writes inside its own home — measured, `EACCES` on `/home/node-aX9`,
 * before `nimbusSessionFiles` took a credential. So both planes carry the
 * agent's credential (`vfs/nimbus-workspace.ts` in this isolate,
 * `execution/nimbus.ts` on a remote session), and the session user stays what it
 * has always been: the ORIGIN, which reads every home and writes its own tree.
 */

import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import { WORKSPACE_ROOT } from './workspace-path';

/**
 * The workspace agent — the one an operator talks to, and the only agent whose
 * home predates this module.
 *
 * Its home is {@link WORKSPACE_ROOT} rather than `/home/main` because
 * `/home/user` is the vendored substrate's own `$HOME`: `DEFAULT_HOME` and
 * `DEFAULT_PATH` (twice) at `@nimbus-sh/core/src/constants.ts:264,267`,
 * `HOME`/`PWD` at `substrate/lifo/kernel/index.ts:200,206`, `os.homedir()` at
 * `substrate/lifo/node-compat/os.ts:8,34`, `.liforc` at `kernel/index.ts:162-170`
 * and the seeded starter project at `vfs/seed-project.ts:31,34`. Renaming it
 * would fork a vendored dependency in those places AND orphan the bytes of
 * every workspace that already exists, to change a string no agent reads. One
 * function answers for every agent, so the substrate's name for its own home
 * stays the substrate's business.
 */
export const MAIN_AGENT = 'main';

/** Owner writes; everyone reads and traverses. See this module's header. */
export const AGENT_HOME_MODE = 0o755;

/** Owner only, and discarded with the agent. */
export const AGENT_TMP_MODE = 0o700;

/**
 * The session user, which is who an unnamed exec still runs as.
 *
 * Fixed rather than allocated: it is the substrate's own session identity, and
 * {@link AGENT_UID_FLOOR} sits above it so no allocated agent can collide with
 * it.
 */
export const SESSION_UID = 1000;

/** Allocated agent uids start here — clear of uid 0 and {@link SESSION_UID}. */
export const AGENT_UID_FLOOR = 2000;

/**
 * Agent names that may become a directory under `/home`.
 *
 * A node's name reaches this module from the search engine's own row, so it is
 * machine-generated rather than typed — which is exactly why it is validated.
 * An unvalidated name containing `/` or `..` writes a home outside `/home` and
 * a boundary is only as good as the path it is enforced on.
 *
 * The first character is narrower than the rest, and that asymmetry is the
 * point: a node id is a `nanoid`, whose alphabet includes `-`, and a directory
 * named `-rf` is a command-line argument at every callsite that ever expands
 * it. Derived names are prefixed (`nodeAgentName`, `subordinateAgentName`,
 * `headAgentName`) so the prefix supplies a safe first character and the id
 * keeps its case, which is what makes the mapping from facet to home
 * injective rather than merely tidy.
 *
 * The length covers the longest valid subordinate slug (64 characters by its
 * own validation) under the four-character `sub-` prefix. Length is not the
 * security property here — the charset is — and directory entries allow far
 * more, so the cap states room rather than a boundary.
 */
const AGENT_NAME_RE = /^[a-z0-9][A-Za-z0-9_-]{0,95}$/;

/** Where this agent's own writes belong. */
export function agentHome(agentName: string): string {
  if (agentName === MAIN_AGENT) return WORKSPACE_ROOT;
  assertAgentName(agentName);
  return `/home/${agentName}`;
}

/**
 * This agent's private `/tmp` as a logical absolute path.
 *
 * Hosted Nimbus sessions create this ordinary directory and use it for
 * `TMPDIR`. In the in-isolate filesystem it is the logical name the confined
 * principal sees; the registry below receives its storage key instead, so a
 * physical `tmp/<agent>` root can never be mistaken for a second user-visible
 * `/tmp` path.
 */
export function agentTmpRoot(agentName: string): string {
  assertAgentName(agentName);
  return `/tmp/${agentName}`;
}

/**
 * A subordinate's name as an agent, and therefore its directory under `/home`.
 *
 * The slug arrives validated by the roster that minted it, and it is validated
 * again here: a home is a path, and the roster's rule and this module's rule
 * are checked at different times by different callers, so either one could
 * drift. The `sub-` prefix keeps the kind visible in a listing and keeps one
 * namespace for every facet kind without a subordinate ever sharing a home
 * with a node or a head.
 */
export function subordinateAgentName(subordinateName: string): string {
  const agentName = `sub-${subordinateName}`;
  assertAgentName(agentName);
  return agentName;
}

/**
 * A head's name as an agent, and therefore its directory under `/home`.
 *
 * Head ids are engine-minted like node ids, so the same prefix rule applies:
 * `head-` supplies the safe first character and the id stays untouched, which
 * keeps the mapping injective. An id the engine never mints — one holding a
 * slash, a quote, a space — is refused here rather than escaped, because an
 * escaped home is a home no other reader can derive, and the grader and
 * merge-back must derive it.
 */
export function headAgentName(headId: string): string {
  const agentName = `head-${headId}`;
  assertAgentName(agentName);
  return agentName;
}

/** The private tmp root's storage key. Keep this at the confinement boundary:
 * every other caller addresses the one logical path from {@link agentTmpRoot}. */
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

/**
 * The identity an agent's commands run as.
 *
 * `gid` equals `uid` — each agent is its own group — so group membership is
 * never an accidental second way into a sibling's home.
 */
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
 * This agent's uid, allocated once and durable thereafter.
 *
 * Durable because it is a row: an agent whose home outlives the activation that
 * made it must come back as the SAME owner, or its own home stops being
 * writable by it — and a node's home has to survive to be graded at settle even
 * though its `/tmp` does not.
 *
 * Idempotent by `ON CONFLICT DO NOTHING` plus a read, so a re-provision is a
 * lookup. `uid` is UNIQUE, which is what makes the allocation safe under a
 * concurrent insert rather than merely unlikely to collide: the loser's insert
 * is refused and both readers converge on the row that landed.
 */
export function agentIdentity(sql: SqlDatabase, agentName: string): AgentIdentity {
  if (agentName === MAIN_AGENT) return { uid: SESSION_UID, gid: SESSION_UID };
  assertAgentName(agentName);
  ensureIdentityTable(sql);
  // `WHERE true` is required, not decorative: with an INSERT..SELECT upsert
  // SQLite cannot tell `ON CONFLICT` from a join's `ON` clause without a WHERE
  // closing the SELECT, and refuses to parse the statement at all.
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

/** This agent's identity when one was allocated, and null before that. A
 *  release reads and never allocates: a name that never had a home has nothing
 *  to give back. */
function allocatedAgentIdentity(sql: SqlDatabase, agentName: string): AgentIdentity | null {
  const [row] = [...sql.exec(`SELECT uid, gid FROM ${IDENTITY_TABLE} WHERE agent_name = ?`, agentName)];
  return row ? { uid: Number(row.uid), gid: Number(row.gid) } : null;
}

/**
 * The narrow root-credentialled surface a home's lifecycle needs.
 *
 * Five synchronous methods, structurally satisfied by
 * `SqliteVFS.as(CRED_KERNEL)`. Named here rather than importing
 * `CredentialedVfs` so this module asks for what it uses instead of a
 * sixty-method dependency, and so a host can hand it a narrower view.
 */
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

/**
 * The directories an agent's layout is made of, and the ownership each must end
 * up with. One table, read by the one applier below, so there is one answer to
 * who owns a home and at what mode.
 */
interface AgentDir {
  readonly path: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

/** An agent's home and its private tmp, in the order they must be created. */
function agentHomeLayout(agentName: string, identity: AgentIdentity): readonly AgentDir[] {
  return [
    { path: agentHome(agentName), uid: identity.uid, gid: identity.gid, mode: AGENT_HOME_MODE },
    { path: agentTmpRoot(agentName), uid: identity.uid, gid: identity.gid, mode: AGENT_TMP_MODE },
  ];
}

/**
 * Create this agent's layout and hand it over, host-side.
 *
 * The order is forced rather than chosen: a per-agent `chown` is uid-0 only
 * (`SqliteVFS` allows a non-root credential its own uid and a group it already
 * belongs to), so an agent cannot create its own home — the host creates it,
 * gives it away, then sets the mode. Idempotent, because an agent that comes
 * back after an eviction must find the home it already owns rather than a
 * refusal.
 */
export function provisionAgentHome(root: HomeRootVfs, agentName: string, identity: AgentIdentity): string {
  for (const dir of agentHomeLayout(agentName, identity)) {
    root.mkdir(dir.path, { recursive: true });
    root.chown(dir.path, dir.uid, dir.gid);
    root.chmod(dir.path, dir.mode);
  }
  return agentHome(agentName);
}

/**
 * Make `/tmp` resolve to this agent's own tmp for this agent's uid.
 *
 * The directory itself is {@link provisionAgentHome}'s, because it is a line in
 * the layout table like the home is. This registers the rewrite and nothing
 * else, and it exists only in this isolate: `confinePrincipal` is a `SqliteVFS`
 * method with no RPC, so a remote session points `TMPDIR` at the same directory
 * and a command that hardcodes `/tmp` there lands in the shared one.
 */
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
 * Reclaim this agent's bytes, and only its bytes.
 *
 * Its uid row is NOT dropped: the allocation is durable so an agent that comes
 * back after a reset finds the identity it already had, and nothing else in
 * the tree is keyed by it. The `/tmp` rewrite IS dropped: a released principal
 * with a live rewrite would resolve `/tmp` onto a root that no longer exists.
 * Idempotent, so the release of a home that was never provisioned removes
 * nothing and allocates nothing.
 */
export function releaseAgentHome(
  root: HomeRootVfs,
  confiner: TmpConfiner,
  sql: SqlDatabase,
  agentName: string,
): void {
  // The workspace agent's home IS the workspace root; releasing it is never a
  // release.
  if (agentName === MAIN_AGENT) throw new Error('the workspace agent has no home to release');
  for (const path of [agentHome(agentName), agentTmpRoot(agentName)]) {
    if (root.exists(path)) root.removeRecursive(path);
  }
  const identity = allocatedAgentIdentity(sql, agentName);
  if (identity) confiner.releasePrincipal(identity.uid);
}

/**
 * Re-register every live `/tmp` rewrite on a registry that has just been
 * created.
 *
 * The layout is rows and inodes; the registry is isolate memory. A filesystem
 * that opens after an eviction therefore carries every home and no rewrite,
 * and a confined principal writing `/tmp/x` into it is refused by the shared
 * scratch — measured, "Permission denied" from the shell and `EACCES` from the
 * file plane — until something registers it again. This is that something,
 * run once per open. An agent whose tmp directory exists was provisioned and
 * never released, so its uid gets its rewrite back; a released one has no
 * directory and gets nothing. Returns how many were restored.
 */
export function restoreAgentTmpConfinements(
  sql: SqlDatabase,
  root: Pick<HomeRootVfs, 'exists'>,
  confiner: TmpConfiner,
): number {
  ensureIdentityTable(sql);
  let restored = 0;
  for (const row of sql.exec(`SELECT agent_name, uid FROM ${IDENTITY_TABLE}`)) {
    const agentName = String(row.agent_name);
    if (!root.exists(agentTmpRoot(agentName))) continue;
    confiner.confinePrincipal(Number(row.uid), agentTmpStorageRoot(agentName));
    restored += 1;
  }
  return restored;
}
