import { exists, readText as nimbusReadText, type VFS, writeText } from '@nimbus-sh/core/vfs/vfs.js';
// Proposed skills: staging, showing, and the owner's decision. Only the owner
// may grant instructions, so nothing else may shorten this path.
//
// Staged bytes live under `.kinu/` because `discoverSkills` reads
// the workspace skills root every turn regardless of trust. Decisions carry the
// displayed digest because list positions can shift between show and decide.
// Trust is written before the file: a trust row without a file is inert; a
// file without a trust row is live in the prompt.

import { instructionDigest } from '../safety/instruction-trust';
import { BUILTIN_SKILL_NAMES, workspaceSkillPath } from '../skills/discover';
import { parseSkillFile, skillNameProblem } from '../skills/parse';

import { vfsDirname } from '../utils/vfs-helpers';
import { Effect, Result } from 'effect';
import { renderThrownChain, settle } from '../obs/index';
import {
  createRefinementStore, refinementRequestView, refinementStagingPath, releaseRefinementLane,
  type RefinementDeps, type RefinementEdit, type RefinementRequest,
  type RefinementRequestView, type RefinementRoute, type RefinementStage,
} from './refinement';

/** The agent's own tree where it has one, as every other skill reader uses. */
function planeOf(deps: RefinementDeps): VFS {
  return deps.control.rt.agentStateVfs ?? deps.control.rt.storage.vfs;
}

async function readText(vfs: VFS, path: string): Promise<string | null> {
  if (!await exists(vfs, path)) return null;
  const read = await nimbusReadText(vfs, path);

  return read;
}

/**
 * Stage one proposed skill where nothing can read it. Refuses invalid skills,
 * built-in names (KINU-N028), non-canonical paths, an existing final path, and
 * any standing approval or revocation for that path. Idempotent.
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
    return refused('this host wires no owner approval authority, so no one here can grant a skill trust');
  }

  const parsed = parseSkillFile(edit.source, 'agent');

  if (Result.isFailure(parsed)) return refused(`the proposed file is not a valid skill: ${parsed.failure.error}`);
  const nameProblem = skillNameProblem(parsed.success.name);

  if (nameProblem !== null) return refused(`skill name ${nameProblem}`);

  if (BUILTIN_SKILL_NAMES[parsed.success.name]) {
    return refused(`"${parsed.success.name}" is a built-in skill: a workspace file may not claim `
      + 'its name, because a built-in carries system placement no file has earned');
  }

  const canonical = workspaceSkillPath(parsed.success.name);

  if (edit.path !== canonical) {
    return refused(`the path must be the canonical skill path for its own name (${canonical}), `
      + `not ${edit.path}: discovery reads that directory and nothing else`);
  }

  const standing = deps.approvals.get(canonical);

  if (standing !== null) {
    return refused(standing.decision === 'revoked'
      ? 'the owner has revoked trust for this path: a refinement must not re-propose bytes they '
        + 'already refused'
      : `the owner already has a standing decision about ${canonical}: a proposal must not talk `
        + 'over it. Revoke that decision first, or propose a differently-named skill');
  }

  const vfs = planeOf(deps);

  if (await exists(vfs, canonical)) {
    return refused(`${canonical} already exists: those bytes are the owner's or another `
      + "author's, and a promotion that overwrote them would not be a promotion. Propose a "
      + 'differently-named skill');
  }

  const staged = refinementStagingPath(request.id, parsed.success.name);
  await vfs.mkdir(vfsDirname(staged), { recursive: true });
  await writeText(vfs, staged, edit.source);

  const route: RefinementRoute = {
    kind: 'skill',
    owner,
    target: canonical,
    disposition: 'pending_owner_approval',
    digest,
    reason: `staged at ${staged}, where no prompt reads it. Read it with \`/refine show\` and `
      + `approve it to write the trust row for ${canonical} and move the file there. `
      + edit.rationale,
  };

  return route;
}

/** The staged bytes for one route, or null when the staging is gone. */
async function readStagedSkill(
  deps: RefinementDeps,
  request: RefinementRequest,
  route: RefinementRoute,
): Promise<string | null> {
  return readText(planeOf(deps), stagedPathFor(request, route));
}

function stagedPathFor(request: RefinementRequest, route: RefinementRoute): string {
  const folder = vfsDirname(route.target);

  return refinementStagingPath(request.id, folder.slice(folder.lastIndexOf('/') + 1));
}

/**
 * The owner's approval surface: the full bytes, never truncated. `digest` is the
 * token passed back to {@link decideRefinementRoute}.
 */
export interface StagedSkillView {
  readonly requestId: string;
  readonly routeIndex: number;
  readonly target: string;
  /** Content address of the staged bytes as they are now. */
  readonly digest: string;
  readonly source: string;
  /** False when something rewrote the staging since proposal; approval refuses. */
  readonly intact: boolean;
}

export type StagedSkillResult =
  | { readonly ok: true; readonly view: StagedSkillView }
  | { readonly ok: false; readonly error: string };

export async function showRefinementRoute(
  deps: RefinementDeps,
  input: { requestId: string; routeIndex: number },
): Promise<StagedSkillResult> {
  const found = locate(deps, input);

  if (Result.isFailure(found)) return { ok: false, error: found.failure };
  const { request, route } = found.success;
  const source = await readStagedSkill(deps, request, route);

  if (source === null) {
    return {
      ok: false,
      error: `the staged file for this edit is gone (${stagedPathFor(request, route)}): nothing to show`,
    };
  }

  return {
    ok: true,
    view: {
      requestId: request.id,
      routeIndex: input.routeIndex,
      target: route.target,
      digest: instructionDigest(source),
      source,
      intact: instructionDigest(source) === route.digest,
    },
  };
}

const DECIDABLE_STAGES = new Set<RefinementStage>(['gated', 'evaluating']);

type Located = Result.Result<{ readonly request: RefinementRequest; readonly route: RefinementRoute }, string>;

function locate(
  deps: RefinementDeps,
  input: { requestId: string; routeIndex: number },
): Located {
  const request = createRefinementStore(deps.control.sql, deps.control.rt.actor).get(input.requestId);

  if (!request) return Result.fail(`no refinement ${input.requestId}`);

  if (!DECIDABLE_STAGES.has(request.stage)) {
    return Result.fail(`refinement ${request.id} is ${request.stage}: its edits are `
      + (request.stage === 'requested' || request.stage === 'planning'
        ? 'not routed yet'
        : 'already settled')
      + ', so there is nothing for you to decide');
  }

  const route = request.routes[input.routeIndex];

  if (!route) return Result.fail(`refinement ${request.id} has no edit ${String(input.routeIndex)}`);

  if (route.kind !== 'skill') {
    return Result.fail(`edit ${String(input.routeIndex)} of ${request.id} is a ${route.kind} edit and needs `
      + 'no decision from you, only a staged skill does');
  }

  if (route.disposition !== 'pending_owner_approval') {
    return Result.fail(`edit ${String(input.routeIndex)} of ${request.id} is already ${route.disposition}`);
  }

  return Result.succeed({ request, route });
}

export const REFINEMENT_DECISIONS = ['approve', 'reject'] as const;

export type RefinementDecision = (typeof REFINEMENT_DECISIONS)[number];

export type RefinementDecisionResult =
  | { readonly ok: true; readonly request: RefinementRequestView; readonly detail: string }
  | { readonly ok: false; readonly error: string };

export interface RefinementDecisionInput {
  readonly requestId: string;
  readonly routeIndex: number;
  /** The digest {@link showRefinementRoute} displayed; binds the decision to bytes, not position. */
  readonly expectedDigest: string;
  readonly decision: RefinementDecision;
}

/**
 * The owner decides one staged skill. Must never be exposed to a model-facing
 * tool: an agent able to call it could approve its own instructions.
 * Approval writes trust for the final path first, then copies, reads back, and
 * verifies the digest before deleting the staging, so a failure is retryable.
 */
export function decideRefinementRoute(
  deps: RefinementDeps,
  input: RefinementDecisionInput,
): Promise<RefinementDecisionResult> {
  return settle(Effect.gen(function* () {
    releaseRefinementLane(deps.control.sql, deps.control.rt.actor.actorId);
    const found = locate(deps, input);

    if (Result.isFailure(found)) return { ok: false, error: found.failure };
    const { request, route } = found.success;
    const approvals = deps.approvals;

    if (!approvals) return { ok: false, error: 'this host wires no owner approval authority' };

    if (input.expectedDigest !== route.digest) {
      return {
        ok: false,
        error: 'that is not the edit you were shown: the proposal has changed since. Run '
          + '`/refine show` again and decide on what it prints',
      };
    }

    const vfs = planeOf(deps);
    const staged = stagedPathFor(request, route);

    if (input.decision === 'reject') {
      yield* Effect.promise(async () => {
        if (await exists(vfs, staged)) await vfs.unlink(staged);
      });

      return patch(deps, {
        request,
        routeIndex: input.routeIndex,
        next: {
          ...route,
          disposition: 'rejected',
          reason: `you rejected these bytes; the staged file is deleted and nothing was written to ${route.target}`,
        },
        detail: `rejected: ${route.target} was never created`,
      });
    }

    const source = yield* Effect.promise(() => readStagedSkill(deps, request, route));

    if (source === null) {
      return { ok: false, error: `the staged file for this edit is gone (${staged}): nothing to approve` };
    }

    if (instructionDigest(source) !== route.digest) {
      return {
        ok: false,
        error: 'the staged bytes changed since they were proposed, so approving them would approve '
          + 'something you were not shown. Re-run the refinement',
      };
    }

    const existing = yield* Effect.promise(() => readText(vfs, route.target));

    if (existing !== null && instructionDigest(existing) !== route.digest) {
      return {
        ok: false,
        error: `${route.target} now holds different bytes: promoting onto it would overwrite `
          + "somebody's file. The staged proposal is left where it is",
      };
    }

    // Trust first; see the module header.
    approvals.approve(route.target, route.digest);
    const promoted = yield* Effect.result(promoteStagedSkill(deps, request, route));

    if (Result.isFailure(promoted)) return { ok: false, error: promoted.failure };

    return patch(deps, {
      request,
      routeIndex: input.routeIndex,
      next: {
        ...route,
        disposition: 'applied',
        reason: `you approved digest ${route.digest}; ${route.target} is now trusted instructions`,
      },
      detail: `approved: ${route.target} is now trusted instructions`,
    });
  }));
}

interface RoutePatch {
  readonly request: RefinementRequest;
  readonly routeIndex: number;
  readonly next: RefinementRoute;
  readonly detail: string;
}

function patch(deps: RefinementDeps, input: RoutePatch): RefinementDecisionResult {
  const { request, routeIndex, next, detail } = input;
  const store = createRefinementStore(deps.control.sql, deps.control.rt.actor);
  const routes = request.routes.map((existing, index) => index === routeIndex ? next : existing);

  if (!store.record(request.id, request.stage, { routes })) {
    return { ok: false, error: `refinement ${request.id} moved while you were deciding` };
  }

  return { ok: true, request: refinementRequestView(store.get(request.id) ?? request), detail };
}

/**
 * Put the approved bytes at the canonical path, verify them, then clear the
 * staging. Idempotent; every settle calls it to repair a crashed promotion.
 * Refuses when the final path holds other bytes or both file and staging are gone.
 * Copy-verify-unlink because core's `VFS` has no rename; the staging outlives
 * every failure.
 */
function promoteStagedSkill(
  deps: RefinementDeps,
  request: RefinementRequest,
  route: RefinementRoute,
): Effect.Effect<boolean, string> {
  return Effect.gen(function* () {
    const vfs = planeOf(deps);
    const staged = stagedPathFor(request, route);
    const expected = route.digest;

    if (expected === undefined) return yield* Effect.fail(`route for ${route.target} carries no digest to verify against`);

    const existing = yield* Effect.promise(() => readText(vfs, route.target));

    if (existing !== null && instructionDigest(existing) !== expected) {
      return yield* Effect.fail(`${route.target} holds bytes that are not the approved ones: refusing to overwrite. `
        + `The proposal is still staged at ${staged}`);
    }

    let moved = false;

    if (existing === null) {
      const source = yield* Effect.promise(() => readStagedSkill(deps, request, route));

      if (source === null) {
        return yield* Effect.fail(`neither ${route.target} nor its staging at ${staged} exists: the approved bytes `
          + 'are gone and cannot be reconstructed');
      }

      if (instructionDigest(source) !== expected) {
        return yield* Effect.fail(`the staging at ${staged} no longer holds the approved bytes: refusing to promote `
          + 'something the owner did not approve');
      }

      // Staging is untouched, so the next settle retries.
      yield* Effect.tryPromise({
        try: async () => {
          await vfs.mkdir(vfsDirname(route.target), { recursive: true });
          await writeText(vfs, route.target, source);
        },
        catch: (cause) => `could not write ${route.target}: ${renderThrownChain({ cause })}`,
      });

      // Read back: a torn or transformed write would be trusted but unapproved.
      const written = yield* Effect.promise(() => readText(vfs, route.target));

      if (written === null || instructionDigest(written) !== expected) {
        return yield* Effect.fail(`${route.target} did not read back as the approved bytes after writing: the `
          + `proposal is still staged at ${staged} and the promotion can be retried`);
      }

      moved = true;
    }

    yield* Effect.promise(() => discardSkillStaging(deps, request, route));

    return moved;
  });
}

async function discardSkillStaging(
  deps: RefinementDeps,
  request: RefinementRequest,
  route: RefinementRoute,
): Promise<void> {
  const vfs = planeOf(deps);
  const staged = stagedPathFor(request, route);

  if (await exists(vfs, staged)) await vfs.unlink(staged);
}

/**
 * The owner's standing answer about one proposed skill's bytes. No row: pending.
 * Revoked or approved for other bytes: rolled_back, staging discarded. Approved
 * for these bytes: completes the promotion, or stays pending with the reason.
 */
export function settleSkillApproval(
  deps: RefinementDeps,
  request: RefinementRequest,
  route: RefinementRoute,
): Promise<{ readonly state: 'applied' | 'rolled_back' | 'pending'; readonly reason?: string }> {
  return settle(Effect.gen(function* () {
    const standing = deps.approvals?.get(route.target);

    if (standing === null || standing === undefined) return { state: 'pending' as const };

    if (standing.decision === 'revoked' || standing.digest !== route.digest) {
      yield* Effect.promise(() => discardSkillStaging(deps, request, route));

      return {
        state: 'rolled_back' as const,
        reason: standing.decision === 'revoked'
          ? 'you revoked trust for these bytes'
          : 'the trust row moved to different bytes, so these are not in effect',
      };
    }

    const promoted = yield* Effect.result(promoteStagedSkill(deps, request, route));

    if (Result.isFailure(promoted)) return { state: 'pending' as const, reason: promoted.failure };

    return { state: 'applied' as const };
  }));
}
