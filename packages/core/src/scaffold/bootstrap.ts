import { markStoreChanged } from '@kinu.run/agent-utils';
/**
 * Scaffold cold-start bootstrap: a fresh workspace writes the `.v0` source, then its row. The `.vN` files and the
 * current row are the loop; nothing else holds a copy.
 */

import type { AgentRuntime } from '../types/agent-runtime';

// Re-exported so a type-only import of the data avoids this file's value imports (see `loop-origin.ts`).
export { defaultLoopOrigin, type LoopOrigin } from './loop-origin';

import type { LoopOrigin } from './loop-origin';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
import { initScaffoldTables } from './schemas';
import { getCurrentScaffoldVersion, scaffoldSource, writeScaffoldVersion } from './versions';

import { nowMs } from '../utils/date';

export const INITIAL_SCAFFOLD_SOURCE = `\
// scaffold/agent.js: v0 (initial bootstrap)
//
// This is the agent's mutable agentic loop. It runs inside the codemode
// sandbox and talks to the host ONLY through the \`host.*\` bridge (the live
// runtime object can't cross the sandbox boundary). The task is the 2nd arg.
//
// The default loop delegates to host.defaultInference(), which runs the
// agent's standard inference (full tools + multi-step) and streams the
// response to the user. An evolved scaffold can replace this delegation with
// its own strategy (MCTS, branching heads, reflection passes, ...) while still
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
  markStoreChanged(rt.storage.sql);
}

/** The one writer of an actor's first loop: the bundled loop as its `.v0` file, then its row. A seeded actor keeps its own. */
export async function bootstrapScaffold(rt: AgentRuntime): Promise<void> {
  initScaffoldTables(rt.storage.execRaw);

  if (getCurrentScaffoldVersion(rt.storage.sql, rt.actor) !== null) return;
  await writeScaffoldVersion(rt, 0, INITIAL_SCAFFOLD_SOURCE);
  insertV0Row(rt);
}

/**
 * Seed a child actor's loop and return the version it points at. Idempotent:
 * an existing pointer is kept.
 *
 * `inherit`/`version` copy the parent's source as the child's v1 rather than
 * pointing at the parent's row, since pointers and claim digests are per actor.
 */
export function seedActorLoop(
  child: AgentRuntime,
  parent: AgentRuntime | null,
  origin: LoopOrigin,
): Promise<{ version: number }> {
  return settle(Effect.gen(function* () {
    initScaffoldTables(child.storage.execRaw);
    const seeded = getCurrentScaffoldVersion(child.storage.sql, child.actor);

    if (seeded !== null) return { version: seeded };

    if (origin.kind === 'builtin') {
      yield* Effect.promise(() => bootstrapScaffold(child));

      return { version: getCurrentScaffoldVersion(child.storage.sql, child.actor) ?? 0 };
    }

    if (parent === null) {
      return yield* new KinuError('bad_input', `a '${origin.kind}' loop origin needs the parent actor whose loop it names`);
    }

    const inherited = yield* inheritedSource(parent, origin);
    const version = 1;
    yield* Effect.promise(() => writeScaffoldVersion(child, version, inherited.source));
    child.actor.assertCurrent();
    void child.storage.sql`
      INSERT OR IGNORE INTO scaffold_versions (actor_id, version, written_at, rationale, status, parent_version)
      VALUES (${child.actor.actorId}, ${version}, ${nowMs()},
        ${`inherited from actor ${parent.actor.actorId} v${inherited.version}`}, 'current', ${inherited.version})`;
    markStoreChanged(child.storage.sql);

    return { version };
  }));
}

function inheritedSource(
  parent: AgentRuntime,
  origin: Extract<LoopOrigin, { kind: 'inherit' | 'version' }>,
): Effect.Effect<{ readonly version: number; readonly source: string }, KinuError> {
  return Effect.gen(function* () {
    if (origin.kind === 'version') {
      parent.actor.assertCurrent();

      const known = parent.storage.sql<{ version: number }>`
        SELECT version FROM scaffold_versions
        WHERE actor_id = ${parent.actor.actorId} AND version = ${origin.version}`.length > 0;

      const source = known ? yield* Effect.promise(() => scaffoldSource(parent, origin.version)) : null;

      if (source === null) {
        return yield* new KinuError('missing', `the parent actor retains no version ${origin.version} to inherit`);
      }

      return { version: origin.version, source };
    }

    const version = getCurrentScaffoldVersion(parent.storage.sql, parent.actor) ?? 0;
    const source = yield* Effect.promise(() => scaffoldSource(parent, version));

    if (source !== null) return { version, source };

    // v0 is INITIAL_SCAFFOLD_SOURCE even before the parent bootstraps, so inherit it.
    // A non-zero version with missing bytes must refuse: its digest cannot be verified.
    if (version === 0) return { version: 0, source: INITIAL_SCAFFOLD_SOURCE };

    return yield* new KinuError('missing', `the parent actor retains no source for its current version ${version}`);
  });
}
