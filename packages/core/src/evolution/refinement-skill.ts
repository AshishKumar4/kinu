import { exists, readText as nimbusReadText, type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// A dream's skills: staged, made trusted at a cold turn, reverted by the owner.
//
// Staged bytes live under `.kinu/` because `discoverSkills` reads the workspace skills root every turn regardless of
// trust, and the skills index is in the prompt prefix: a skill moves the prompt only at a turn whose cache is cold, as
// a section does. Trust is written before the file: a trust row without a file is inert; a file without a trust row
// is in the prompt as reference material.

import { instructionDigest } from '../safety/instruction-trust';
import { checkMisevolutionForSurface, recordMisevolutionVeto } from '../safety/misevolution';
import { BUILTIN_SKILL_NAMES, workspaceSkillPath } from '../skills/discover';
import { parseSkillFile, skillNameProblem } from '../skills/parse';
import type { AgentRuntime } from '../types/agent-runtime';

import { vfsDirname } from '../utils/vfs-helpers';
import { writeConditionally } from '../vfs/conditional-write';
import { Effect, Result } from 'effect';
import { diagnostics, renderThrownChain, settle } from '../obs/index';
import {
  createRefinementStore, refinementStagingPath,
  type RefinementDeps, type RefinementEdit, type RefinementRequest, type RefinementRoute,
} from './refinement';

async function readText(vfs: VFS, path: string): Promise<string | null> {
  if (!await exists(vfs, path)) return null;
  const read = await nimbusReadText(vfs, path);

  return read;
}

/** The skill's name, or why the file is no skill a dream may write: unparsable, a bad name, or a built-in's. */
function skillName(source: string): Result.Result<string, string> {
  const parsed = parseSkillFile(source, 'agent');

  if (Result.isFailure(parsed)) return Result.fail(`the proposed file is not a valid skill: ${parsed.failure.error}`);
  const nameProblem = skillNameProblem(parsed.success.name);

  if (nameProblem !== null) return Result.fail(`skill name ${nameProblem}`);

  if (BUILTIN_SKILL_NAMES[parsed.success.name]) {
    return Result.fail(`"${parsed.success.name}" is a built-in skill: a workspace file may not claim `
      + 'its name, because a built-in carries system placement no file has earned');
  }

  return Result.succeed(parsed.success.name);
}

/** Why a drafted skill is refused before anyone reviews it, or null. A misevolution veto is recorded where every one is. */
export function skillRefusal(deps: RefinementDeps, source: string): string | null {
  const name = skillName(source);

  if (Result.isFailure(name)) return name.failure;
  const misevolution = checkMisevolutionForSurface({ prose: source }, 'skill');

  if (misevolution.ok) return null;
  recordMisevolutionVeto(deps.control.sql, deps.control.rt.actor, { surface: 'skill', violation: misevolution, detail: workspaceSkillPath(name.success) });

  return `misevolution veto (${misevolution.criterionId}): ${misevolution.reason}`;
}

/**
 * Stage one accepted skill where nothing can read it, until a cold turn makes it trusted. Refuses an invalid skill,
 * a built-in name (KINU-N028), a non-canonical path, an existing final path, and any trust row for that path.
 * Idempotent.
 */
export async function routeSkill(
  deps: RefinementDeps,
  edit: Extract<RefinementEdit, { kind: 'skill' }>,
  request: RefinementRequest,
): Promise<RefinementRoute> {
  const owner = 'instruction_approvals';
  const digest = instructionDigest(edit.source);

  const refused = (reason: string): RefinementRoute => ({
    kind: 'skill', owner, target: edit.path, disposition: 'refused', reason,
  });

  if (!deps.approvals) {
    return refused('this host wires no trust authority, so no skill can be trusted here');
  }

  const name = skillName(edit.source);

  if (Result.isFailure(name)) return refused(name.failure);
  const canonical = workspaceSkillPath(name.success);

  if (edit.path !== canonical) {
    return refused(`the path must be the canonical skill path for its own name (${canonical}), `
      + `not ${edit.path}: discovery reads that directory and nothing else`);
  }

  const standing = deps.approvals.get(canonical);

  if (standing !== null) {
    return refused(standing.decision === 'revoked'
      ? 'the owner has revoked trust for this path: a dream must not re-propose bytes they already refused'
      : `${canonical} already has a trust row (${standing.origin === 'dream' ? 'from an earlier dream' : "the owner's"}): `
        + 'a dream must not talk over it. Propose a differently-named skill');
  }

  const vfs = deps.skillsVfs;

  if (await exists(vfs, canonical)) {
    return refused(`${canonical} already exists: those bytes are the owner's or another `
      + "author's, and a dream that overwrote them would not be adding a skill. Propose a "
      + 'differently-named skill');
  }

  const staged = refinementStagingPath(request.id, name.success);
  await vfs.mkdir(vfsDirname(staged), { recursive: true });
  await writeText(vfs, staged, edit.source);

  return {
    kind: 'skill',
    owner,
    target: canonical,
    disposition: 'staged',
    digest,
    reason: `staged at ${staged}, where no prompt reads it; it becomes a trusted skill at ${canonical} at the next `
      + `turn whose prompt cache is cold. ${edit.rationale}`,
  };
}

function stagedPathFor(request: RefinementRequest, route: RefinementRoute): string {
  const folder = vfsDirname(route.target);

  return refinementStagingPath(request.id, folder.slice(folder.lastIndexOf('/') + 1));
}

/**
 * At a turn whose prompt cache is cold, before its skills are read: each skill a dream staged gets its trust row,
 * origin `dream`, then its file. A path the owner revoked, or trusted for other bytes, is left for the lane to roll
 * back. A promotion that failed is retried at the next cold turn, never at a warm one.
 */
export function activateDreamSkills(deps: RefinementDeps): Promise<void> {
  return settle(Effect.gen(function* () {
    const approvals = deps.approvals;

    if (!approvals) return;

    for (const request of createRefinementStore(deps.control.sql, deps.control.rt.actor).settleable()) {
      for (const route of request.routes) {
        if (route.kind !== 'skill' || route.disposition !== 'staged' || route.digest === undefined) continue;
        const standing = approvals.get(route.target);

        if (standing !== null && (standing.decision === 'revoked' || standing.digest !== route.digest)) continue;

        // Trust first; see the module header. A failed promotion stays staged for the next cold turn.
        if (standing === null) approvals.approve(route.target, route.digest, 'dream');
        const promoted = yield* Effect.result(promoteStagedSkill(deps.skillsVfs, request, route));

        if (Result.isSuccess(promoted) && promoted.success) diagnostics.event('dream.skill_applied', { change: route.target, dream: request.id });
      }
    }
  }));
}

/**
 * Put the trusted bytes at the canonical path, verify them, then clear the staging. Idempotent. Refuses when the final
 * path holds other bytes or both file and staging are gone. Copy-verify-unlink because core's `VFS` has no rename;
 * the staging outlives every failure.
 */
function promoteStagedSkill(
  vfs: VFS,
  request: RefinementRequest,
  route: RefinementRoute,
): Effect.Effect<boolean, string> {
  return Effect.gen(function* () {
    const staged = stagedPathFor(request, route);
    const expected = route.digest;

    if (expected === undefined) return yield* Effect.fail(`route for ${route.target} carries no digest to verify against`);

    const existing = yield* Effect.promise(() => readText(vfs, route.target));

    if (existing !== null && instructionDigest(existing) !== expected) {
      return yield* Effect.fail(`${route.target} holds bytes that are not the trusted ones: refusing to overwrite. `
        + `The skill is still staged at ${staged}`);
    }

    let moved = false;

    if (existing === null) {
      const source = yield* Effect.promise(() => readText(vfs, staged));

      if (source === null) {
        return yield* Effect.fail(`neither ${route.target} nor its staging at ${staged} exists: the trusted bytes `
          + 'are gone and cannot be reconstructed');
      }

      if (instructionDigest(source) !== expected) {
        return yield* Effect.fail(`the staging at ${staged} no longer holds the reviewed bytes: refusing to promote `
          + 'something nobody reviewed');
      }

      // Created only where no file is, in one call on the plane's side: bytes the owner wrote since the read above are
      // refused, never overwritten. Staging is untouched, so the next cold turn retries.
      yield* Effect.tryPromise({
        try: async () => {
          await vfs.mkdir(vfsDirname(route.target), { recursive: true });
          await writeConditionally(vfs, route.target, new TextEncoder().encode(source), { kind: 'absent' });
        },
        catch: (cause) => `could not create ${route.target}: ${renderThrownChain({ cause })}. The skill is still staged at ${staged}`,
      });

      // Read back: a torn or transformed write would be trusted but unreviewed.
      const written = yield* Effect.promise(() => readText(vfs, route.target));

      if (written === null || instructionDigest(written) !== expected) {
        return yield* Effect.fail(`${route.target} did not read back as the reviewed bytes after writing: the `
          + `skill is still staged at ${staged} and the next cold turn retries`);
      }

      moved = true;
    }

    yield* Effect.promise(() => discardSkillStaging(vfs, request, route));

    return moved;
  });
}

async function discardSkillStaging(vfs: VFS, request: RefinementRequest, route: RefinementRoute): Promise<void> {
  const staged = stagedPathFor(request, route);

  if (await exists(vfs, staged)) await vfs.unlink(staged);
}

/**
 * Where a dream's staged skill stands, read and never written to the skills root: no trust row yet is pending (a cold
 * turn has not come), a revoked or moved one is rolled back with its staging discarded, and trust with the file in
 * place is applied.
 */
export function settleDreamSkill(
  deps: RefinementDeps,
  request: RefinementRequest,
  route: RefinementRoute,
): Promise<{ readonly state: 'applied' | 'rolled_back' | 'pending'; readonly reason?: string }> {
  return settle(Effect.gen(function* () {
    const standing = deps.approvals?.get(route.target);
    const vfs = deps.skillsVfs;

    if (standing === null || standing === undefined) return { state: 'pending' as const };

    if (standing.decision === 'revoked' || standing.digest !== route.digest) {
      yield* Effect.promise(() => discardSkillStaging(vfs, request, route));

      return {
        state: 'rolled_back' as const,
        reason: standing.decision === 'revoked'
          ? 'you revoked trust for these bytes'
          : 'the trust row moved to different bytes, so these are not in effect',
      };
    }

    const written = yield* Effect.promise(() => readText(vfs, route.target));

    if (written !== null && instructionDigest(written) === route.digest) return { state: 'applied' as const };

    return {
      state: 'pending' as const,
      reason: written === null
        ? `${route.target} is trusted but not yet written: the next cold turn writes it`
        : `${route.target} holds other bytes, so the trusted ones cannot be written there`,
    };
  }));
}

/**
 * The owner's revert of a dream's skill, staged or in effect: trust is revoked, so no dream proposes that path again,
 * and the file goes while it still holds the dream's bytes. A file the owner has since rewritten is theirs and stays,
 * untrusted. The route reads `rejected`.
 */
export async function revertDreamSkill(
  rt: AgentRuntime,
  skills: Pick<RefinementDeps, 'approvals' | 'skillsVfs'>,
  input: { readonly requestId: string; readonly routeIndex: number },
): Promise<{ readonly ok: true; readonly detail: string } | { readonly ok: false; readonly error: string }> {
  const { approvals } = skills;

  if (approvals === undefined) return { ok: false, error: 'this host wires no trust authority, so no skill can be reverted here' };
  const store = createRefinementStore(rt.storage.sql, rt.actor);
  const request = store.get(input.requestId);
  const route = request?.routes[input.routeIndex];

  if (request === null || route?.kind !== 'skill' || route.digest === undefined) {
    return { ok: false, error: `no dream skill at ${input.requestId} edit ${String(input.routeIndex)}` };
  }

  if (route.disposition !== 'staged' && route.disposition !== 'applied') {
    return { ok: false, error: `${route.target} is ${route.disposition}: nothing to revert` };
  }

  approvals.revoke(route.target);
  const vfs = skills.skillsVfs;
  const file = await readText(vfs, route.target);
  const removed = file !== null && instructionDigest(file) === route.digest;

  if (removed) await vfs.unlink(route.target);
  await discardSkillStaging(vfs, request, route);

  const routes = request.routes.map((existing, index) => index === input.routeIndex
    ? { ...existing, disposition: 'rejected' as const, reason: 'you reverted it: its trust is revoked and its file removed' }
    : existing);

  if (!store.record(request.id, request.stage, { routes })) return { ok: false, error: `dream ${request.id} moved while you were reverting` };
  diagnostics.event('dream.skill_reverted', { change: route.target, dream: request.id });

  return { ok: true, detail: removed ? `removed ${route.target} and revoked its trust` : `revoked trust for ${route.target}` };
}
