// PROPOSED SKILLS — staging, showing, and the owner's decision.
//
// The one artifact a refinement can propose that has no evaluated lane of its
// own. A prompt section earns its way live through held-out trials; a fact is
// earned by the user's own sentence. A skill is instructions, and the only thing
// that can grant instructions is the owner. So this module is the whole path
// from "the refiner wrote a file" to "the owner made it real", and nothing else
// in the system may shorten it.
//
// WHY STAGING EXISTS. Writing the file to `/workspace/skills/<name>.md` and
// letting content-addressed trust hold it `unverified` does NOT stop it
// influencing behaviour. Trust decides PLACEMENT and tool policy, not
// visibility: `discoverSkills` walks that directory every turn, so the file's
// front matter enters the skills index and its body renders in the unverified
// reference tier. The model reads it. A proposal that changes what the next turn
// reads has already been applied, which is the one thing this lane exists to
// prevent. So the bytes wait under `.kinu/` (`refinementStagingPath`), which
// neither `discoverSkills` nor `gatherApprovableInstructions` walks.
//
// WHY THE DECISION CARRIES A DIGEST. An owner decides on BYTES, and the only
// thing that identifies bytes is their content address. A decision addressed by
// list position alone is a decision about whatever happens to be at that
// position when it lands — and the list can shift, the staging can be rewritten,
// and the request can be re-driven between the reading and the clicking. So
// `show` hands out the digest it displayed and `decide` refuses anything else.
//
// WHY TRUST IS WRITTEN BEFORE THE FILE. Both orders can be interrupted. Trust
// first leaves an approval for a file that does not exist, which nothing
// discovers and the next settle completes. File first leaves a discovered file
// with no trust row: live, unverified, in the prompt, waiting for a dead process
// to finish. One window is inert and the other is the leak.

import { instructionDigest } from '../safety/instruction-trust';
import { BUILTIN_SKILL_NAMES, skillPath } from '../skills/discover';
import { parseSkillFile, skillNameProblem } from '../skills/parse';
import { SKILLS_DIR } from '../skills/types';
import type { VFS } from '../types/primitives';
import { renderThrownChain } from '../obs/index';
import {
  createRefinementStore, refinementRequestView, refinementStagingPath,
  type RefinementDeps, type RefinementEdit, type RefinementRequest,
  type RefinementRequestView, type RefinementRoute, type RefinementStage,
} from './refinement';

/** The file plane a proposal's bytes live on — the agent's own tree where it has
 *  one, exactly as every other reader of skills spells it. */
function planeOf(deps: RefinementDeps): VFS {
  return deps.control.rt.agentStateVfs ?? deps.control.rt.storage.vfs;
}

async function readText(vfs: VFS, path: string): Promise<string | null> {
  if (!await vfs.exists(path)) return null;
  const read = await vfs.readFile(path, { encoding: 'utf8' });
  return read instanceof Uint8Array ? new TextDecoder().decode(read) : read;
}

/**
 * Stage one proposed skill where nothing can read it.
 *
 * WHAT IT REFUSES:
 *   • a file that is not a valid skill, or a name the filename rules reject;
 *   • a built-in skill's name, which no workspace file may claim (KINU-N028);
 *   • a path that is not the canonical skill path for its own name;
 *   • a final path that ALREADY EXISTS, whoever wrote it — a promotion that had
 *     to overwrite is not a promotion;
 *   • any standing approval or revocation for that path, which are answers the
 *     owner has already given and a proposal must not talk over.
 *
 * Idempotent: staging the same bytes twice is one file, so a re-driven route
 * adopts its own staging.
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
  if (!parsed.ok) return refused(`the proposed file is not a valid skill: ${parsed.error}`);
  const nameProblem = skillNameProblem(parsed.skill.name);
  if (nameProblem !== null) return refused(`skill name ${nameProblem}`);
  if (BUILTIN_SKILL_NAMES[parsed.skill.name]) {
    return refused(`"${parsed.skill.name}" is a built-in skill — a workspace file may not claim `
      + 'its name, because a built-in carries system placement no file has earned');
  }
  const canonical = skillPath(parsed.skill.name);
  if (edit.path !== canonical) {
    return refused(`the path must be the canonical skill path for its own name (${canonical}), `
      + `not ${edit.path} — discovery reads that directory and nothing else`);
  }

  const standing = deps.approvals.get(canonical);
  if (standing !== null) {
    return refused(standing.decision === 'revoked'
      ? 'the owner has revoked trust for this path — a refinement must not re-propose bytes they '
        + 'already refused'
      : `the owner already has a standing decision about ${canonical} — a proposal must not talk `
        + 'over it. Revoke that decision first, or propose a differently-named skill');
  }

  const vfs = planeOf(deps);
  if (await vfs.exists(canonical)) {
    return refused(`${canonical} already exists — those bytes are the owner's or another `
      + "author's, and a promotion that overwrote them would not be a promotion. Propose a "
      + 'differently-named skill');
  }

  const staged = refinementStagingPath(request.id, parsed.skill.name);
  await vfs.mkdir(stagingDirOf(staged), { recursive: true });
  await vfs.writeFile(staged, edit.source);
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

/** The staging file's own directory. Its own function because the staging path
 *  is the only place in this system that nests a directory per request. */
function stagingDirOf(staged: string): string {
  return staged.slice(0, staged.lastIndexOf('/'));
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
  const name = route.target.slice(route.target.lastIndexOf('/') + 1).replace(/\.md$/u, '');
  return refinementStagingPath(request.id, name);
}

/**
 * WHAT AN OWNER READS BEFORE DECIDING.
 *
 * The full bytes, never a preview. Everything else about this flow is bounded —
 * the changelog card shows an excerpt, the listing shows a line — because those
 * are for scanning. This one is the approval surface, and a truncated approval
 * surface asks for a decision about bytes the decider could not see, which is
 * the same failure as approving blind. A skill file is bounded by exactly what
 * bounds every skill file (the turn's admission allocation defers an oversize
 * body), so there is no ceiling of this module's own to apply.
 *
 * `digest` is the TOKEN. It is what the owner passes back to approve or reject,
 * and what {@link decideRefinementRoute} checks, so a decision is always about
 * the bytes this call displayed.
 */
export interface StagedSkillView {
  readonly requestId: string;
  readonly routeIndex: number;
  /** The canonical path the bytes would be promoted to. */
  readonly target: string;
  /** The content address of the staged bytes as they are RIGHT NOW. */
  readonly digest: string;
  /** The whole file. Never truncated. */
  readonly source: string;
  /** True when the staged bytes still match what the proposal recorded. False
   *  means something rewrote the staging, and approval will refuse. */
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
  if (!found.ok) return { ok: false, error: found.error };
  const { request, route } = found;
  const source = await readStagedSkill(deps, request, route);
  if (source === null) {
    return {
      ok: false,
      error: `the staged file for this edit is gone (${stagedPathFor(request, route)}) — nothing to show`,
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

/** The stages in which a routed edit is still the owner's to decide. Outside
 *  them the routes are either not made yet or already settled, and a decision
 *  would be writing into a request nothing is watching. */
const DECIDABLE_STAGES = new Set<RefinementStage>(['gated', 'evaluating']);

type Located =
  | { readonly ok: true; readonly request: RefinementRequest; readonly route: RefinementRoute }
  | { readonly ok: false; readonly error: string };

/** Find one decidable route, refusing every way the reference can be wrong. */
function locate(
  deps: RefinementDeps,
  input: { requestId: string; routeIndex: number },
): Located {
  const request = createRefinementStore(deps.control.sql).get(input.requestId);
  if (!request) return { ok: false, error: `no refinement ${input.requestId}` };
  if (!DECIDABLE_STAGES.has(request.stage)) {
    return {
      ok: false,
      error: `refinement ${request.id} is ${request.stage} — its edits are `
        + (request.stage === 'requested' || request.stage === 'planning'
          ? 'not routed yet'
          : 'already settled')
        + ', so there is nothing for you to decide',
    };
  }
  const route = request.routes[input.routeIndex];
  if (!route) {
    return { ok: false, error: `refinement ${request.id} has no edit ${String(input.routeIndex)}` };
  }
  if (route.kind !== 'skill') {
    return {
      ok: false,
      error: `edit ${String(input.routeIndex)} of ${request.id} is a ${route.kind} edit and needs `
        + 'no decision from you — only a staged skill does',
    };
  }
  if (route.disposition !== 'pending_owner_approval') {
    return {
      ok: false,
      error: `edit ${String(input.routeIndex)} of ${request.id} is already ${route.disposition}`,
    };
  }
  return { ok: true, request, route };
}

/** What an owner may say about one staged skill. */
export const REFINEMENT_DECISIONS = ['approve', 'reject'] as const;
export type RefinementDecision = (typeof REFINEMENT_DECISIONS)[number];

export type RefinementDecisionResult =
  | { readonly ok: true; readonly request: RefinementRequestView; readonly detail: string }
  | { readonly ok: false; readonly error: string };

export interface RefinementDecisionInput {
  readonly requestId: string;
  readonly routeIndex: number;
  /**
   * The digest {@link showRefinementRoute} displayed.
   *
   * REQUIRED, and it is what makes the decision a decision about bytes rather
   * than about a list position. Between reading and deciding, the request can be
   * re-driven, the routes can be re-ordered, and the staging can be rewritten;
   * every one of those changes the digest and none of them changes the index.
   */
  readonly expectedDigest: string;
  readonly decision: RefinementDecision;
}

/**
 * The OWNER decides one staged skill.
 *
 * Reachable only from an owner surface — the CF callable is gated `interactive`
 * and the CLI command runs at the terminal. Deliberately absent from every
 * model-facing tool surface: this is the act that turns proposed bytes into
 * system instructions, so an agent able to call it could approve its own.
 *
 * APPROVAL ORDER, and every step is a refusal that matters:
 *
 *   1. the route must be decidable and the digest must be the one shown;
 *   2. the staged bytes must still hash to that digest;
 *   3. the final path must be absent, or hold these exact bytes already;
 *   4. write the InstructionApproval for the FINAL path and digest;
 *   5. copy the staged bytes onto the final path, READ THEM BACK, and verify the
 *      digest before deleting the staging.
 *
 * Step 5's read-back is not paranoia. A partial or transformed write would leave
 * a file that discovery admits and the trust row vouches for, whose content is
 * not what the owner approved — a trusted skill nobody wrote. Verifying before
 * the unlink means the staging survives every failure, so the promotion is
 * always retryable and never half-done.
 */
export async function decideRefinementRoute(
  deps: RefinementDeps,
  input: RefinementDecisionInput,
): Promise<RefinementDecisionResult> {
  const found = locate(deps, input);
  if (!found.ok) return { ok: false, error: found.error };
  const { request, route } = found;
  if (!deps.approvals) return { ok: false, error: 'this host wires no owner approval authority' };
  if (input.expectedDigest !== route.digest) {
    return {
      ok: false,
      error: 'that is not the edit you were shown — the proposal has changed since. Run '
        + '`/refine show` again and decide on what it prints',
    };
  }

  const vfs = planeOf(deps);
  const staged = stagedPathFor(request, route);
  if (input.decision === 'reject') {
    // The bytes go. A staged proposal nobody will act on is the only kind of
    // state worth deleting.
    if (await vfs.exists(staged)) await vfs.unlink(staged);
    return patch(deps, request, input.routeIndex, {
      ...route,
      disposition: 'rejected',
      reason: `you rejected these bytes; the staged file is deleted and nothing was written to ${route.target}`,
    }, `rejected — ${route.target} was never created`);
  }

  const source = await readStagedSkill(deps, request, route);
  if (source === null) {
    return { ok: false, error: `the staged file for this edit is gone (${staged}) — nothing to approve` };
  }
  if (instructionDigest(source) !== route.digest) {
    return {
      ok: false,
      error: 'the staged bytes changed since they were proposed, so approving them would approve '
        + 'something you were not shown. Re-run the refinement',
    };
  }

  const existing = await readText(vfs, route.target);
  if (existing !== null && instructionDigest(existing) !== route.digest) {
    return {
      ok: false,
      error: `${route.target} now holds different bytes — promoting onto it would overwrite `
        + "somebody's file. The staged proposal is left where it is",
    };
  }

  // Trust FIRST. See the module header.
  deps.approvals.approve(route.target, route.digest);
  const promoted = await promoteStagedSkill(deps, request, route);
  if (!promoted.ok) return { ok: false, error: promoted.error };
  return patch(deps, request, input.routeIndex, {
    ...route,
    disposition: 'applied',
    reason: `you approved digest ${route.digest}; ${route.target} is now trusted instructions`,
  }, `approved — ${route.target} is now trusted instructions`);
}

/** Rewrite one route on the row, in place, without moving the stage. */
function patch(
  deps: RefinementDeps,
  request: RefinementRequest,
  routeIndex: number,
  next: RefinementRoute,
  detail: string,
): RefinementDecisionResult {
  const store = createRefinementStore(deps.control.sql);
  const routes = request.routes.map((existing, index) => index === routeIndex ? next : existing);
  if (!store.record(request.id, request.stage, { routes })) {
    return { ok: false, error: `refinement ${request.id} moved while you were deciding` };
  }
  return { ok: true, request: refinementRequestView(store.get(request.id) ?? request), detail };
}

type PromotionOutcome =
  | { readonly ok: true; readonly moved: boolean }
  | { readonly ok: false; readonly error: string };

/**
 * Put the approved bytes at the canonical path and clear the staging behind
 * them, verifying the result before anything is deleted.
 *
 * IDEMPOTENT, and called both by the approval and by every later settle, so a
 * process that died anywhere inside a promotion is repaired by whoever looks
 * next. Every reachable state is either correct or recoverable:
 *
 *   trust row, no file, staging present → copied and verified now.
 *   trust row, right file, staging present → staging deleted now.
 *   trust row, right file, no staging → done; nothing to do.
 *   trust row, WRONG file → refused, staging kept. Something else wrote there
 *     and this must not overwrite it; the collision is surfaced, not resolved.
 *   trust row, no file, no staging → refused. The bytes are gone and this cannot
 *     invent them.
 *
 * Copy-then-verify-then-unlink rather than a rename because core's `VFS`
 * (`types/primitives.ts`) offers no rename and every backend implements that
 * narrow interface. The guarantee is not move atomicity — it is that the staging
 * outlives every failure, and that nothing is deleted until the final file has
 * been read back and found to be exactly the approved bytes.
 */
async function promoteStagedSkill(
  deps: RefinementDeps,
  request: RefinementRequest,
  route: RefinementRoute,
): Promise<PromotionOutcome> {
  const vfs = planeOf(deps);
  const staged = stagedPathFor(request, route);
  const expected = route.digest;
  if (expected === undefined) {
    return { ok: false, error: `route for ${route.target} carries no digest to verify against` };
  }

  const existing = await readText(vfs, route.target);
  if (existing !== null && instructionDigest(existing) !== expected) {
    return {
      ok: false,
      error: `${route.target} holds bytes that are not the approved ones — refusing to overwrite. `
        + `The proposal is still staged at ${staged}`,
    };
  }

  let moved = false;
  if (existing === null) {
    const source = await readStagedSkill(deps, request, route);
    if (source === null) {
      return {
        ok: false,
        error: `neither ${route.target} nor its staging at ${staged} exists — the approved bytes `
          + 'are gone and cannot be reconstructed',
      };
    }
    if (instructionDigest(source) !== expected) {
      return {
        ok: false,
        error: `the staging at ${staged} no longer holds the approved bytes — refusing to promote `
          + 'something the owner did not approve',
      };
    }
    try {
      await vfs.mkdir(SKILLS_DIR, { recursive: true });
      await vfs.writeFile(route.target, source);
    } catch (err) {
      // The staging is untouched, so the next settle tries again. A failed copy
      // must not look like a finished promotion.
      return { ok: false, error: `could not write ${route.target}: ${renderThrownChain({ cause: err })}` };
    }
    // THE READ-BACK. A torn or transformed write leaves a file discovery admits
    // and the trust row vouches for, whose content is not what was approved.
    const written = await readText(vfs, route.target);
    if (written === null || instructionDigest(written) !== expected) {
      return {
        ok: false,
        error: `${route.target} did not read back as the approved bytes after writing — the `
          + `proposal is still staged at ${staged} and the promotion can be retried`,
      };
    }
    moved = true;
  }

  await discardSkillStaging(deps, request, route);
  return { ok: true, moved };
}

/**
 * Delete a staged proposal's file.
 *
 * Called when the bytes have been promoted, and when they never will be — a
 * rejection, a revocation, a digest the owner moved past. Staging that outlives
 * its decision is state nothing will ever read, and unlike the request row it
 * carries no history worth keeping: the row already records what was proposed.
 */
async function discardSkillStaging(
  deps: RefinementDeps,
  request: RefinementRequest,
  route: RefinementRoute,
): Promise<void> {
  const vfs = planeOf(deps);
  const staged = stagedPathFor(request, route);
  if (await vfs.exists(staged)) await vfs.unlink(staged);
}

/**
 * The owner's standing answer about one proposed skill's exact bytes, plus the
 * one repair a crash can require.
 *
 *   • no row at all → the owner has not decided, and there is no clock on them:
 *     pending.
 *   • revoked → these bytes are not in effect, and the staging is discarded:
 *     rolled_back.
 *   • approved for a DIFFERENT digest → the decision is about other bytes, so
 *     this proposal's are not in effect, and its staging is discarded too.
 *   • approved for THIS digest → the promotion is completed if a crash left it
 *     half-done, and the route is applied. A promotion that CANNOT complete
 *     stays pending with its reason on the row rather than claiming a success
 *     nobody achieved.
 */
export async function settleSkillApproval(
  deps: RefinementDeps,
  request: RefinementRequest,
  route: RefinementRoute,
): Promise<{ readonly state: 'applied' | 'rolled_back' | 'pending'; readonly reason?: string }> {
  const standing = deps.approvals?.get(route.target);
  if (standing === null || standing === undefined) return { state: 'pending' };
  if (standing.decision === 'revoked' || standing.digest !== route.digest) {
    await discardSkillStaging(deps, request, route);
    return {
      state: 'rolled_back',
      reason: standing.decision === 'revoked'
        ? 'you revoked trust for these bytes'
        : 'the trust row moved to different bytes, so these are not in effect',
    };
  }
  const promoted = await promoteStagedSkill(deps, request, route);
  if (!promoted.ok) return { state: 'pending', reason: promoted.error };
  return { state: 'applied' };
}
