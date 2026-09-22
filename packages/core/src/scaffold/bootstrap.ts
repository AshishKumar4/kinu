/**
 * Scaffold cold-start bootstrap and activation refresh. Fresh workspaces write
 * `.v0` source, then its row, then the live view; every run converges the live
 * view onto the current pointer's version file.
 */

import type { AgentRuntime } from '../types/agent-runtime';

// Re-exported so a type-only import of the data avoids this file's value imports (see `loop-origin.ts`).
export { defaultLoopOrigin, type LoopOrigin } from './loop-origin';

import type { LoopOrigin } from './loop-origin';
import { KinuError } from '../obs/error';
import { initScaffoldTables } from './schemas';
import { getCurrentScaffoldVersion, readScaffoldVersion, readVersionedScaffoldSource } from './shadow';
import { readScaffoldFileText } from './surface';
import { nowMs } from '../utils/date';

export const INITIAL_SCAFFOLD_SOURCE = `\
// scaffold/agent.js — v0 (initial bootstrap)
//
// This is the agent's mutable agentic loop. It runs inside the codemode
// sandbox and talks to the host ONLY through the \`host.*\` bridge (the live
// runtime object can't cross the sandbox boundary). The task is the 2nd arg.
//
// The default loop delegates to host.defaultInference(), which runs the
// agent's standard inference (full tools + multi-step) and streams the
// response to the user. An evolved scaffold can replace this delegation with
// its own strategy (MCTS, branching heads, reflection passes, …) while still
// reaching the model + tools via host.llmStream / host.callTool.

async function* run(rt, task) {
  await host.defaultInference();
}
`;

const V0_RATIONALE = 'initial bootstrap';

function insertV0Row(rt: AgentRuntime): void {
  rt.actor.assertCurrent();
  void rt.storage.sql`
    INSERT OR IGNORE INTO scaffold_versions (actor_id, version, written_at, rationale)
    VALUES (${rt.actor.actorId}, 0, ${nowMs()}, ${V0_RATIONALE})
  `;
}

export async function bootstrapScaffold(rt: AgentRuntime): Promise<void> {
  initScaffoldTables(rt.storage.execRaw);
  const sql = rt.storage.sql;
  const vfs = rt.agentStateVfs ?? rt.storage.vfs;
  const path = rt.identity.scaffold.path;
  const versionedPath = (version: number) => `${path}.v${version}`;

  let current = getCurrentScaffoldVersion(sql, rt.actor);
  const liveExists = await vfs.exists(path);

  if (current === null && !liveExists) {
    await vfs.writeFile(versionedPath(0), INITIAL_SCAFFOLD_SOURCE);
    insertV0Row(rt);
    await rt.identity.scaffold.write(INITIAL_SCAFFOLD_SOURCE);

    return;
  }

  // Preserved workspace: seed the pointer's version file from the live source once.
  const seededVersion = current ?? 0;

  if (!(await vfs.exists(versionedPath(seededVersion)))) {
    if (!liveExists) return;
    await vfs.writeFile(versionedPath(seededVersion), await readScaffoldFileText(vfs, path));
  }

  if (current === null) {
    insertV0Row(rt);
    current = getCurrentScaffoldVersion(sql, rt.actor);
  }

  const activeVersion = current;

  if (activeVersion === null || !(await vfs.exists(versionedPath(activeVersion)))) return;
  const canonical = await readScaffoldFileText(vfs, versionedPath(activeVersion));

  if (!liveExists || (await readScaffoldFileText(vfs, path)) !== canonical) {
    await rt.identity.scaffold.write(canonical);
  }
}


/**
 * Seed a child actor's loop and return the version it points at. Idempotent:
 * an existing pointer is kept.
 *
 * `inherit`/`version` copy the parent's source as the child's v1 rather than
 * pointing at the parent's row, since pointers and claim digests are per actor.
 */
export async function seedActorLoop(
  child: AgentRuntime,
  parent: AgentRuntime | null,
  origin: LoopOrigin,
): Promise<{ version: number }> {
  initScaffoldTables(child.storage.execRaw);
  const seeded = getCurrentScaffoldVersion(child.storage.sql, child.actor);

  if (seeded !== null) return { version: seeded };

  if (origin.kind === 'builtin') {
    await bootstrapScaffold(child);

    return { version: getCurrentScaffoldVersion(child.storage.sql, child.actor) ?? 0 };
  }

  if (parent === null) {
    throw new KinuError('bad_input', `a '${origin.kind}' loop origin needs the parent actor whose loop it names`);
  }

  const inherited = await inheritedSource(parent, origin);
  const version = 1;
  const vfs = child.agentStateVfs ?? child.storage.vfs;
  await vfs.writeFile(`${child.identity.scaffold.path}.v${version}`, inherited.source);
  child.actor.assertCurrent();
  void child.storage.sql`
    INSERT OR IGNORE INTO scaffold_versions (actor_id, version, written_at, rationale, status, parent_version)
    VALUES (${child.actor.actorId}, ${version}, ${nowMs()},
      ${`inherited from actor ${parent.actor.actorId} v${inherited.version}`}, 'current', ${inherited.version})`;
  await child.identity.scaffold.write(inherited.source);

  return { version };
}

async function inheritedSource(
  parent: AgentRuntime,
  origin: Extract<LoopOrigin, { kind: 'inherit' | 'version' }>,
): Promise<{ readonly version: number; readonly source: string }> {
  if (origin.kind === 'version') {
    parent.actor.assertCurrent();

    const known = parent.storage.sql<{ version: number }>`
      SELECT version FROM scaffold_versions
      WHERE actor_id = ${parent.actor.actorId} AND version = ${origin.version}`.length > 0;

    const source = known ? await readVersionedScaffoldSource(parent, origin.version) : null;

    if (source === null) {
      throw new KinuError('missing', `the parent actor retains no version ${origin.version} to inherit`);
    }

    return { version: origin.version, source };
  }

  const version = getCurrentScaffoldVersion(parent.storage.sql, parent.actor) ?? 0;
  const source = await readScaffoldVersion(parent, version);

  if (source !== null) return { version, source };

  // v0 is INITIAL_SCAFFOLD_SOURCE even before the parent bootstraps, so inherit it.
  // A non-zero version with missing bytes must refuse: its digest cannot be verified.
  if (version === 0) return { version: 0, source: INITIAL_SCAFFOLD_SOURCE };
  throw new KinuError('missing', `the parent actor retains no source for its current version ${version}`);
}
