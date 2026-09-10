/**
 * Scaffold cold-start bootstrap and activation refresh.
 *
 * On a fresh workspace the canonical `.v0` source lands first, its metadata
 * row second, and the live `scaffold/agent.js` view last. On a preserved
 * workspace the one-shot seed copies the live source into `.v{current}` so
 * the archive becomes canonical without inventing content. Every run then
 * converges the rebuildable live view onto the current pointer's version
 * file — the heal for a crash that landed between a pointer flip and the
 * view write.
 */

import type { AgentRuntime } from '../types/agent-runtime';

// Re-exported, not re-declared: the DATA lives in a module with no value
// import so a type-only reference to it cannot drag this file's own imports
// onto a caller's graph. See `loop-origin.ts` for the nine layer-gate
// violations that taught us the difference.
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
    // Fresh workspace: canonical source, then its row, then the view.
    await vfs.writeFile(versionedPath(0), INITIAL_SCAFFOLD_SOURCE);
    insertV0Row(rt);
    await rt.identity.scaffold.write(INITIAL_SCAFFOLD_SOURCE);

    return;
  }

  // Preserved workspace — seed the pointer's version file from the live
  // source exactly once; the view is the only source such a workspace has.
  const seededVersion = current ?? 0;

  if (!(await vfs.exists(versionedPath(seededVersion)))) {
    if (!liveExists) return; // no source anywhere — surfaces at execution read
    await vfs.writeFile(versionedPath(seededVersion), await readScaffoldFileText(vfs, path));
  }

  if (current === null) {
    insertV0Row(rt);
    current = getCurrentScaffoldVersion(sql, rt.actor);
  }

  // Activation refresh: converge the live view onto the current pointer.
  const activeVersion = current;

  if (activeVersion === null || !(await vfs.exists(versionedPath(activeVersion)))) return;
  const canonical = await readScaffoldFileText(vfs, versionedPath(activeVersion));

  if (!liveExists || (await readScaffoldFileText(vfs, path)) !== canonical) {
    await rt.identity.scaffold.write(canonical);
  }
}


/**
 * Seed a child actor's loop in the ONE workspace store, and say which version
 * it now points at.
 *
 * Idempotent: an actor that already has a pointer keeps it, so a re-acquired
 * actor is not re-seeded and a promotion it has since made is not undone.
 *
 * `inherit` and `version` COPY the parent's retained source as this actor's v1
 * and record `parent_version`, rather than pointing at the parent's row: the
 * pointer is per actor (`scaffold_versions` PK is `(actor_id, version)`), a
 * turn's claim names the digest of the source its own actor retains, and a
 * child that read its parent's row would run bytes its own claim could not
 * verify after the parent promoted again.
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

/** The parent bytes an inheriting child starts from, or a refusal naming what
 *  the parent does not retain. */
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

  // A PARENT AT v0 IS ON THE SHIPPED LOOP, and inheriting from it means
  // starting there — not refusing. The row and the file only appear once the
  // parent has been bootstrapped, so a workspace whose root has never taken a
  // turn retains no v0 bytes to read, and a head or node created before that
  // first turn was refused with "retains no source for its current version 0".
  // That refusal named a real absence and drew the wrong conclusion: v0 IS
  // {@link INITIAL_SCAFFOLD_SOURCE}, the same bytes `bootstrapScaffold` would
  // write, so the honest answer is the shipped loop rather than an error.
  //
  // A NON-ZERO version whose bytes are gone still refuses, and must: the parent
  // promoted to something this child cannot read, so what it would inherit
  // cannot be established, and a claim naming a digest of bytes nobody has is
  // exactly what recovery refuses to verify later.
  if (version === 0) return { version: 0, source: INITIAL_SCAFFOLD_SOURCE };
  throw new KinuError('missing', `the parent actor retains no source for its current version ${version}`);
}
