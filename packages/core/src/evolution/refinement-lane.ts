import { exists, readText } from '@nimbus-sh/core/vfs/vfs.js';
// The refinement lane: turns a captured trajectory into typed edits in the
// authorities that already own them.
//
// `requestRefinement` opens the durable row with no model call and no artifact
// write; `advanceRefinementLane` runs one step. Crash recovery is
// `resetStalePlanning`: a row whose answer was not persisted is asked again.
//
// The dreamer (deep tier), its reviewer and its reviser (fast tier) are each one
// structured call (`askHelper`): the provider is held to the answer's schema, and
// the schema validates what it returns. Every write is made here against a named owner. Nothing here promotes: sections, tool texts and skills are staged for
// the next cold turn, subagent specs are refused, and facts must be backed by the
// user's own sentence in the reviewed turns.

import { renderWatch } from './watch';
import { changeOwners, changeStanding, type ChangeOwners } from './change-standing';
import { confusedPicks, renderConfusedPicks } from './picks';
import { discoverSkills } from '../skills/discover';
import type { InstructionTrustResolver } from '../types/instruction-trust';
import { Effect, Result } from 'effect';
import * as v from 'valibot';

import { scoreAuthoredEdit } from './judge';
import { artifactBody, bundledArtifact, listArtifactVersions, MAX_EDIT_CHARS, sectionArtifact, stageArtifact, toolArtifact, type ArtifactEvidence } from './artifacts';
import { BUILTIN_TOOL_DESCRIPTIONS } from '../tools/registry';
import { isCorrected, isLowRating, listTurnRatings, renderRatedTurn, type TurnRating } from './ratings';
import type { DecisionQuestion } from '../providers/decision-model';
import {
  MIN_EDIT_RATIONALE, REFINEMENT_EDIT_KINDS, REFINEMENT_PROPOSAL_EXAMPLE,
  RefinementProposalSchema, createRefinementStore, DreamVerdictsSchema, evolutionDebt, refinementRequestView,
  type DreamVerdict, type EditEvidence, type RefinementClaim, type RefinementDeps, type RefinementStore,
  type RefinementEdit, type RefinementProposal, type RefinementRequest,
  type RefinementRequestView, type RefinementRoute, type RefinementScope, type RefinementStage,
  type RefinementTrigger, type SettleRefinementPatch,
} from './refinement';
import { PROMPT_SECTIONS } from '../prompting/section-templates';
import { routeSkill, settleDreamSkill, skillRefusal } from './refinement-skill';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../utils/evidence-window';
import { jsonObjectOnlyInstruction } from '../providers/structured';
import { attempt, diagnostics, renderThrownChain, settle, toKinuError, type KinuError } from '../obs/index';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { MEMORY_PATH } from '../memory/note';

export interface RequestRefinementInput {
  readonly trigger: RefinementTrigger;
  readonly scope: RefinementScope;
  /** Omitted: the workspace's unresolved negative outcomes. */
  readonly turnIds?: readonly string[];
  readonly debtKey?: string;
}

/** Shared by request-time and claim-time refusal so the owner reads one sentence. */
const ACCOUNT_SCOPE_REFUSAL =
  'account scope is refused: every authority reachable from a workspace database '
  + '(agent_facts, artifact_versions, instruction_approvals) is scoped to THIS '
  + 'workspace, so there is nothing here that can write account-wide state. Applying '
  + 'it to one workspace instead would put a preference somewhere the owner did not ask for.';

/**
 * Open one refinement request at `requested`, with no model call. Account scope
 * and a trajectory with nothing graded are refused up front as a durable
 * refused row, not a throw.
 */
export async function requestRefinement(
  deps: RefinementDeps,
  input: RequestRefinementInput,
): Promise<RefinementRequestView> {
  const sql = deps.control.sql;
  const actor = deps.control.rt.actor;
  const store = createRefinementStore(sql, actor);
  const turnIds = input.turnIds ?? evolutionDebt(sql, actor).turnIds;

  // Keep the caller's (reading) order; the ledger only filters to rated turns.
  const graded = new Set(listTurnRatings(sql, actor, { turnIds }).map((row) => row.turnId));

  const reviewed = turnIds.filter((id) => graded.has(id));

  let requestInput: Parameters<typeof store.open>[0] = {
    trigger: input.trigger,
    scope: input.scope,
    turnIds: reviewed,
  };

  if (input.debtKey !== undefined) {
    requestInput = { ...requestInput, debtKey: input.debtKey };
  }

  const { request } = store.open(requestInput);

  const refuse = (detail: string): RefinementRequestView => {
    store.advance(request.id, 'requested', 'refused', { detail });

    return refinementRequestView(store.get(request.id) ?? request);
  };

  if (input.scope === 'account') return refuse(ACCOUNT_SCOPE_REFUSAL);

  if (reviewed.length === 0) {
    return refuse(turnIds.length === 0
      ? 'no outcome-labeled turns yet: chat with the agent first'
      : `${'no outcome-labeled turns yet: chat with the agent first'}; none of the ${String(turnIds.length)} `
        + 'named turns carries an outcome');
  }

  return refinementRequestView(request);
}

/** The cheapest step of a dream, before any draft: one decision-model question over the batch. */
export const TRIAGE = {
  worth: {
    type: 'noul',
    instructions: 'Does any of these turns show something the agent should change about how it works: a correction or a '
      + 'repeated request from the user, a tool it struggled with, a misunderstanding, or needless length? Each turn\'s '
      + 'RATED line is how its user\'s next words read.',
  },
} as const satisfies Record<string, DecisionQuestion>;

/**
 * Above every batch of only well-rated, uncorrected turns Clef triaged among 98 recorded batches (the highest 0.22), so
 * such a batch stops; a middling one Clef sees something in goes on (`scripts/triage-recall.ts`, 2026-10-20).
 */
const TRIAGE_YES = 0.25;

/**
 * An automatic dream, or null when none is owed. `cadence` needs five new rated turns, `idle` one. A batch with a turn
 * rated low or likely corrected goes to the dreamer by rule; the decision model triages any other: below `TRIAGE_YES`
 * the dream ends there, its turns covered, and nothing is drafted. Safe every tick: the debt key is the idempotency
 * key, and a taken batch stops counting. No decision model, or one that refused (already said to the owner), opens
 * nothing and leaves the turns owed.
 */
export async function dreamRequest(
  deps: RefinementDeps,
  trigger: Extract<RefinementTrigger, 'cadence' | 'idle'>,
): Promise<RefinementRequestView | null> {
  const { sql, rt } = deps.control;
  const debt = evolutionDebt(sql, rt.actor);

  if (debt.turnIds.length === 0 || (trigger === 'cadence' && !debt.owed) || rt.decide === undefined) return null;
  const turns = listTurnRatings(sql, rt.actor, { turnIds: debt.turnIds });
  const flagged = turns.some((turn) => isLowRating(turn.score) || isCorrected(turn));
  const worth = flagged ? null : (await rt.decide({ state: turns.map(renderRatedTurn).join('\n\n---\n\n'), questions: TRIAGE }))?.answers.worth;

  if (!flagged && worth?.type !== 'noul') return null;
  const opened = await requestRefinement(deps, { trigger, scope: 'workspace', turnIds: debt.turnIds, debtKey: debt.key });

  if (opened.stage !== 'requested') return opened;
  const store = createRefinementStore(sql, rt.actor);
  const of = `${String(turns.length)} turn${turns.length === 1 ? '' : 's'}`;

  if (worth?.type !== 'noul') store.record(opened.id, 'requested', { detail: `A turn was rated low or corrected among ${of}` });
  else if (worth.noul < TRIAGE_YES) store.advance(opened.id, 'requested', 'refused', { detail: `Triage found nothing worth changing in ${of} (p=${worth.noul.toFixed(2)})` });
  else store.record(opened.id, 'requested', { detail: `Triage found something worth a look in ${of} (p=${worth.noul.toFixed(2)})` });

  const settled = store.get(opened.id);

  return settled === null ? opened : refinementRequestView(settled);
}

export type RefinementLaneStep =
  | { readonly step: 'planned'; readonly request: RefinementRequestView }
  | { readonly step: 'settled'; readonly request: RefinementRequestView }
  | { readonly step: 'idle' };

/**
 * Advance the loop by one step: settle an owner-decided request first (free),
 * else run the refiner for the oldest owed request. The claim makes concurrent
 * callers safe; the loser reports `idle`. Stale-planning recovery runs on every
 * pass and skips tokens this process is still running.
 */
export function advanceRefinementLane(
  deps: RefinementDeps,
): Promise<RefinementLaneStep> {
  return settle(Effect.gen(function* () {
    const store = createRefinementStore(deps.control.sql, deps.control.rt.actor);
    store.resetStalePlanning();

    // `gated` too: a host killed between routing and settle leaves the row there.
    for (const waiting of store.settleable()) {
      const step = yield* attempt({ doing: `settling refinement ${waiting.id}`, otherwise: 'unavailable' },
        () => settleRoutes(deps, waiting)).pipe(
        Effect.map((settled): RefinementLaneStep | null => settled && { step: 'settled', request: settled }),
        Effect.catch((failure) => Effect.sync(() => laneHeld(store, waiting, renderThrownChain({ cause: failure })))),
      );

      if (step) return step;
    }

    const owed = store.nextRequested();

    if (!owed) return IDLE;
    const claimed = store.claim(owed.id);

    if (!claimed) return IDLE;

    return yield* plan(deps, claimed).pipe(
      // Null: the claim was lost to recovery and this pass wrote nothing.
      Effect.map((planned): RefinementLaneStep => planned === null ? IDLE : { step: 'planned', request: planned }),
      Effect.catchDefect((defect) => Effect.fail(toKinuError({ doing: `planning refinement ${owed.id}`, cause: defect, otherwise: 'unavailable' }))),
      Effect.catch((failure) => planFailed(store, owed, failure)),
      // A claim left registered would make recovery skip a row nothing drives.
      Effect.ensuring(Effect.sync(() => { claimed.release(); })),
    );
  }));
}

const IDLE: RefinementLaneStep = { step: 'idle' };

function planFailed(store: RefinementStore, owed: RefinementRequest, failure: KinuError): Effect.Effect<RefinementLaneStep, KinuError> {
  const current = store.get(owed.id) ?? owed;
  const detail = renderThrownChain({ cause: failure });

  // A helper's own failure is its answer and refuses the dream (`askHelper`): what reaches here failed around it, and
  // a later pass plans the row again.
  if (current.stage === 'planning') return Effect.fail(failure);

  return Effect.succeed(laneHeld(store, current, detail));
}

/** The row keeps its stage and says what failed; the next pass tries it again. */
function laneHeld(store: RefinementStore, request: RefinementRequest, detail: string): RefinementLaneStep {
  store.record(request.id, request.stage, { detail });

  return { step: 'idle' };
}

/** `applied` or `rejected`. Fact `applied` is included: re-routing a fact is a no-op. */
function ownerHasDecided(route: RefinementRoute): boolean {
  return route.disposition === 'applied' || route.disposition === 'rejected';
}

/** Reading order; `listTurnRatings` is newest-first. */
function reviewedTrajectory(
  sql: SqlExecutor, actor: ActorHandle, request: RefinementRequest,
): TurnRating[] {
  const byId = new Map(listTurnRatings(sql, actor, { turnIds: request.turnIds }).map((row) => [row.turnId, row] as const));

  return request.turnIds
    .map((id) => byId.get(id))
    .filter((row): row is TurnRating => row !== undefined);
}

/**
 * Run the refiner for one claimed request, persist its proposal, route its edits, and settle. Null when this pass
 * lost the claim.
 *
 * The proposal is persisted before the first owner write, so `resume` re-routes the same edits, adopting existing
 * owner records instead of asking the refiner again. The claim is re-checked before every owner write: owners are
 * stores the row cannot guard. `settleRoutes` runs right after `gated`, so fact-only proposals reach `applied` in the
 * same pass.
 */
function plan(
  deps: RefinementDeps,
  claim: RefinementClaim,
): Effect.Effect<RefinementRequestView | null, KinuError> {
  return Effect.gen(function* () {
    const { request } = claim;
    const store = createRefinementStore(deps.control.sql, deps.control.rt.actor);

    const view = (): RefinementRequestView =>
      refinementRequestView(store.get(request.id) ?? request);

    const refuse = (detail: string, rejected?: RefinementProposal): RefinementRequestView | null => {
      let patch: SettleRefinementPatch = { detail };

      if (rejected !== undefined) patch = { ...patch, proposal: rejected, routes: [] };

      if (!claim.advance('refused', patch)) return null;

      return view();
    };

    // A resumed claim reuses its plan; the on-disk writes belong to it.
    let proposal = request.proposal;

    if (proposal === null) {
      const answered = yield* askRefiner(deps, request);

      if (Result.isFailure(answered)) return refuse(answered.failure);
      proposal = answered.success;
    }

    if (proposal.scope !== request.scope) {
      return refuse(
        `the refiner proposed at ${proposal.scope} scope and this request is ${request.scope} scope: `
        + (proposal.scope === 'account' ? ACCOUNT_SCOPE_REFUSAL : 'the scopes must match'),
        proposal,
      );
    }

    if (proposal.edits.length === 0) {
      return refuse(`the refiner proposed no edits: ${proposal.summary}`, proposal);
    }

    // Persist the plan before any owner write; also the first claim fence.
    if (request.proposal === null
      && !claim.record({ proposal, detail: proposal.summary })) return null;

    const reviewed = reviewedTrajectory(deps.control.sql, deps.control.rt.actor, request);
    const reviewing = yield* review(deps, claim, { request, proposal, reviewed });

    // The claim was lost.
    if (reviewing === null) return null;

    if ('refused' in reviewing) return refuse(reviewing.refused, proposal);
    ({ proposal } = reviewing);
    const { round } = reviewing;
    const routes: RefinementRoute[] = [];

    for (const [index, edit] of proposal.edits.entries()) {
      // Never re-route an owner-decided route: that would re-ask the owner and
      // could un-apply a real promotion.
      const decided = request.routes[index];

      if (decided !== undefined && ownerHasDecided(decided)) {
        routes.push(decided);
        continue;
      }

      if (!claim.held()) return null;
      const evidence = round.evidence.find((measured) => measured.edit === index);
      const verdict = round.verdicts.find((judged) => judged.edit === index);
      const unrouted = evidence?.refused ?? (verdict?.verdict === 'accept' ? null : reviewerRefusal(verdict));

      routes.push(unrouted === null
        ? yield* routeEdit(deps, { edit, request, reviewed, ...(evidence?.artifact !== undefined && { artifact: evidence.artifact }) })
        : { kind: edit.kind, owner: editOwnerAndTarget(edit)[0], target: editOwnerAndTarget(edit)[1], disposition: 'refused', reason: unrouted });

      // Persist after each route; a crash keeps them recorded.
      if (!claim.record({ routes })) return null;
    }

    if (!claim.advance('gated', { routes, detail: proposal.summary })) return null;

    const settled = yield* attempt({ doing: `settling refinement ${request.id}`, otherwise: 'unavailable' },
      () => settleRoutes(deps, store.get(request.id) ?? request));

    return settled ?? view();
  });
}

type RefinerAnswer = Result.Result<RefinementProposal, string>;

function reviewerRefusal(verdict: DreamVerdict | undefined): string {
  if (verdict === undefined) return 'the reviewer gave it no verdict';

  return verdict.verdict === 'revise'
    ? `the reviewer still asked for a revision after the one the dreamer made: ${verdict.note}`
    : `the reviewer rejected it: ${verdict.note}`;
}

type ReviewOutcome = { readonly proposal: RefinementProposal; readonly round: { readonly evidence: readonly EditEvidence[]; readonly verdicts: readonly DreamVerdict[] } } | { readonly refused: string };

/**
 * The cross-judgement: each drafted edit measured (`scoreEdits`), the reviewer's verdict on all of them, and, if it
 * asks for a revision, one revision by the dreamer, measured and judged again. Every answer is recorded before the
 * next step, so a pass that resumes asks no helper twice. Null when the claim is lost.
 */
function review(
  deps: RefinementDeps,
  claim: RefinementClaim,
  input: { readonly request: RefinementRequest; readonly proposal: RefinementProposal; readonly reviewed: readonly TurnRating[] },
): Effect.Effect<ReviewOutcome | null, KinuError> {
  return Effect.gen(function* () {
    const { request, reviewed } = input;
    let { proposal } = input;
    const rounds = [...request.review.rounds];

    for (;;) {
      if (rounds.length === 0) {
        rounds.push({ evidence: yield* scoreEdits(deps, proposal, request, reviewed), verdicts: null });

        if (!claim.record({ review: { rounds } } satisfies SettleRefinementPatch)) return null;
      }

      const latest = rounds[rounds.length - 1];

      if (latest === undefined) return { refused: 'the review has no round' };
      const round = rounds.length - 1;

      if (latest.verdicts === null) {
        const judged = yield* askHelper(deps, {
          roleLabel: 'dream reviewer', tier: 'fast',
          brief: () => renderReviewerBrief(deps, request, { proposal, evidence: latest.evidence, reviewed }),
        }, DreamVerdictsSchema);

        if (Result.isFailure(judged)) return { refused: judged.failure };
        rounds[round] = { evidence: latest.evidence, verdicts: [...judged.success.verdicts] };

        if (!claim.record({ review: { rounds } } satisfies SettleRefinementPatch)) return null;
        continue;
      }

      // An edit the size gate refused goes back for the one revision whatever the reviewer said, with what it measured:
      // its author can bring it within the limit, which no reviewer can (glm and kimi dreams, 2026-10-23: 13 of 19
      // section edits refused for size, the reviewers' notes asking for them shorter).
      const sendBack = round === 0 ? withSizeRevisions(latest.verdicts, latest.evidence) : latest.verdicts;

      // One revision at most: a second request for one is a rejection.
      if (round > 0 || !sendBack.some((verdict) => verdict.verdict === 'revise')) {
        return { proposal, round: { evidence: latest.evidence, verdicts: latest.verdicts } };
      }

      const revised = yield* askHelper(deps, {
        roleLabel: 'dreamer', tier: 'fast',
        brief: () => renderReviseBrief(deps, request, { proposal, verdicts: sendBack }),
      }, RefinementProposalSchema);

      // A revision that does not answer, or answers at another scope, leaves the first round's verdicts standing.
      if (Result.isFailure(revised) || revised.success.scope !== request.scope) {
        return { proposal, round: { evidence: latest.evidence, verdicts: latest.verdicts } };
      }

      proposal = revised.success;
      rounds.push({ evidence: yield* scoreEdits(deps, proposal, request, reviewed), verdicts: null });

      if (!claim.record({ review: { rounds }, proposal, detail: proposal.summary } satisfies SettleRefinementPatch)) return null;
    }
  });
}

/** The reviewer's verdicts, with every edit the size gate refused, whether the reviewer named it or not, sent back for a
 *  revision that names the measure. */
function withSizeRevisions(verdicts: readonly DreamVerdict[], evidence: readonly EditEvidence[]): DreamVerdict[] {
  const oversized = evidence.filter((measured) => measured.revisable === true && measured.refused !== undefined);

  return [
    ...verdicts.filter((verdict) => !oversized.some((measured) => measured.edit === verdict.edit)),
    ...oversized.map((measured): DreamVerdict => {
      const said = verdicts.find((verdict) => verdict.edit === measured.edit);

      return {
        edit: measured.edit, verdict: 'revise',
        note: `a fixed gate refused it (${measured.refused ?? ''}): change only the sentences the lesson needs, or drop it.${said === undefined ? '' : ` The reviewer said: ${said.note}`}`,
      };
    }),
  ];
}

/** What the reviewer reads about each edit, measured before it is judged; a static gate's refusal routes it nowhere. */
function scoreEdits(
  deps: RefinementDeps, proposal: RefinementProposal, request: RefinementRequest, reviewed: readonly TurnRating[],
): Effect.Effect<EditEvidence[], KinuError> {
  return Effect.forEach(proposal.edits.entries(), ([edit, change]) => attempt(
    { doing: `measuring the drafted ${change.kind} edit`, otherwise: 'unavailable' },
    async (): Promise<EditEvidence> => {
      switch (change.kind) {
        case 'fact': {
          const quoted = checkQuote(change.quote, reviewed);

          return Result.isFailure(quoted) ? { edit, note: '', refused: quoted.failure } : { edit, note: `the user's own words: "${change.quote.trim()}"` };
        }

        case 'prompt_section':
        case 'tool_description': {
          const decide = deps.control.rt.decide;

          if (decide === undefined) return { edit, note: '', refused: 'no decision model is wired to measure the edit' };
          const artifactId = editOwnerAndTarget(change)[1];
          const scored = await scoreAuthoredEdit({ rt: deps.control.rt, decide }, { artifactId, body: change.source, turns: request.turnIds });

          if (!('refused' in scored)) return { edit, note: scored.detail, artifact: scored.evidence };

          return { edit, note: '', refused: scored.refused, ...(scored.oversized && { revisable: true }) };
        }

        case 'skill': {
          const refused = skillRefusal(deps, change.source);

          return refused === null ? { edit, note: `a skill file of ${String(Buffer.byteLength(change.source, 'utf8'))} bytes` } : { edit, note: '', refused };
        }

        case 'subagent_spec':
          return { edit, note: '', refused: SUBAGENT_SPEC_REFUSAL };
      }
    },
  ));
}

/** What a fact must say, which the dreamer drafts by and the reviewer holds it to: the world model shows every fact on
 *  every turn, and the glm pilot's dreamed "all UI work goes to the expert lane" ran a layout request into a staffing step
 *  (EVAL-5, 2026-10-23). */
const FACT_SCOPE = 'A fact is shown to the agent on every later turn, whatever the work: its value names the situation '
  + 'it holds for, in the user\'s terms ("when they ask for a deploy, ..."), is never a rule for all work, and leaves out '
  + 'what held only for the session it was said in.';

/** The owner's order for where a lesson goes, which the dreamer drafts by and the reviewer holds it to. */
const EDIT_PRIORITY = 'Put a lesson in the first place that can carry it: a prompt section or a tool description, then a '
  + 'memory fact, and a skill last. A skill is for a multi-step procedure that no prompt section or tool description '
  + 'can carry; the owner does not want skills that could have been avoided.';

/** The headings the dreamer's and the reviewer's briefs share. */
const DREAM_BRIEF_HEADINGS = {
  watch: '## What changed since, and how the turns went',
  picks: '## Skills and tools picked, then switched from or corrected',
  answer: '## Your answer',
} as const;

/** Instruction files the dreamer reads, each as it is now, where present: `memory/MEMORY.md` is where genesis
 *  (`workspace-birth.ts`) writes it; `AGENTS.md` is owner-written. */
const REFINER_CONTEXT_CANDIDATES: readonly string[] = [MEMORY_PATH, 'AGENTS.md'];

/** At most this much of each, so one long file cannot crowd the turns out of the brief: with twelve turns at their full
 *  windows, the largest brief stays under 64k tokens, half of a 128k window. */
const CONTEXT_FILE_CHARS = 10_000;

async function contextFiles(deps: RefinementDeps): Promise<string> {
  const vfs = deps.control.rt.storage.vfs;
  const present: string[] = [];

  for (const path of REFINER_CONTEXT_CANDIDATES) {
    if (await exists(vfs, path)) present.push(`### ${path}\n${evidenceWindow(await readText(vfs, path), CONTEXT_FILE_CHARS)}`);
  }

  return present.length === 0 ? '(none in this workspace)' : present.join('\n\n');
}

/**
 * A dream's helper: one structured call, the provider held to `schema` by its structured output and the answer
 * validated against it (`RoutedLLM.object`): the dreamer on the deep tier, its reviewer and its one revision on the
 * fast. A failure, the provider's or the schema's, is the helper's answer.
 */
function askHelper<S extends v.GenericSchema>(
  deps: RefinementDeps,
  helper: { readonly roleLabel: string; readonly tier: 'deep' | 'fast'; readonly brief: () => Promise<string> },
  schema: S,
): Effect.Effect<Result.Result<v.InferOutput<S>, string>, KinuError> {
  // The deep tier is the judge's route, so a draft is spent where an edit's judging is.
  const llm = helper.tier === 'deep' ? deps.control.rt.judgeModel : deps.control.rt.fastLlm;

  if (llm === undefined) return Effect.succeed(Result.fail(`the ${helper.roleLabel} has no ${helper.tier} route on this host`));

  // A brief that could not be written fails the pass, which a later one retries; the call's own failure is its answer.
  return attempt({ doing: `writing the ${helper.roleLabel}'s brief`, otherwise: 'unavailable' }, helper.brief).pipe(
    Effect.flatMap((task) => Effect.tryPromise({
      try: async () => Result.succeed(await llm.object(task, schema)),
      catch: (cause) => toKinuError({ doing: `asking the ${helper.roleLabel}`, cause, otherwise: 'unavailable' }),
    }).pipe(
      // An answer off the schema names the first key it got wrong (`generateObjectReported`), so a refusal says what to fix.
      Effect.catch((failure) => Effect.succeed(Result.fail(`the ${helper.roleLabel} did not answer (${failure.code}): ${renderThrownChain({ cause: failure })}`))),
    )),
  );
}

function askRefiner(deps: RefinementDeps, request: RefinementRequest): Effect.Effect<RefinerAnswer, KinuError> {
  return askHelper(deps, { roleLabel: 'dreamer', tier: 'deep', brief: () => renderRefinerBrief(deps, request) }, RefinementProposalSchema);
}

/**
 * The refiner's brief: trajectory, addressable artifacts, prior refinements, and the answer shape.
 *
 * Turns are bounded by `EVIDENCE_BUDGETS`. The answer shape is printed from `REFINEMENT_PROPOSAL_EXAMPLE`, so brief and
 * schema cannot disagree.
 */
async function renderRefinerBrief(deps: RefinementDeps, request: RefinementRequest): Promise<string> {
  const sql = deps.control.sql;
  const actor = deps.control.rt.actor;

  const reviewed = reviewedTrajectory(sql, actor, request);
  const trajectory = reviewed.map((row, index) => renderReviewedTurn(row, index)).join('\n\n');
  const picks = await picksSection(deps, reviewed);

  // Each as the agent reads it now, so an edit replaces the text in effect, not the bundled one.
  const current = (label: string, text: string): string => `### ${label} (${String(Buffer.byteLength(text, 'utf8'))} bytes)\n${text.trimEnd()}`;

  const sections = PROMPT_SECTIONS
    .map((section) => current(section.id, artifactBody(sql, actor, sectionArtifact(section.id)) ?? section.source))
    .join('\n\n');

  const tools = Object.keys(BUILTIN_TOOL_DESCRIPTIONS).map((tool) => {
    const schema = artifactBody(sql, actor, toolArtifact(tool, 'schema'));

    return [current(`${tool} description`, artifactBody(sql, actor, toolArtifact(tool, 'description')) ?? ''), ...(schema === null ? [] : [current(`${tool} schema`, schema)])].join('\n\n');
  }).join('\n\n');

  const facts = deps.facts.recentTopK(20);

  const factLines = facts.length === 0
    ? '  (none recorded)'
    : facts.map((fact) => `  - ${fact.key}`).join('\n');

  const history = dreamHistory(sql, actor, request);

  // Printed from a schema-valid value at this request's scope, which `plan` enforces.
  const answer: RefinementProposal = { ...REFINEMENT_PROPOSAL_EXAMPLE, scope: request.scope };
  const answerKeys = Object.keys(answer).map((key) => `\`${key}\``).join(', ');

  return [
    'You are reviewing this agent\'s own recent failures to propose the SMALLEST typed edits',
    'that would have prevented them. You have no write access. Your answer is a proposal that',
    'deterministic gates and a judge of recorded turns will decide on. Propose no edit the turns',
    'do not show a need for: no edits at all is an answer.',
    '',
    `## The trajectory under review (${String(reviewed.length)} graded turns)`,
    '',
    trajectory || '(no graded turns you may reflect on)',
    '',
    '## The artifacts you may address, and their owners',
    '',
    EDIT_PRIORITY,
    '',
    'Registered prompt sections (`prompt_section`), each as it reads now: replacing one costs every turn its bytes,',
    'and a longer section must earn them with a strictly better measured score. An edit to a section or a tool text',
    `changes at most ${String(MAX_EDIT_CHARS)} characters of it, counted as the words it removes plus the words it adds:`,
    'a larger change is refused before anyone reads it. Write the whole text back with only the sentences the lesson',
    'needs changed, every other word as it is.',
    '',
    sections,
    '',
    'Built-in tool texts (`tool_description`), each as it reads now: what the agent reads about each tool on every',
    'turn, its description or its input fields\' descriptions (`schema`, one JSON object). Change one where the turns',
    'show the agent misusing that tool, or picking it where another fits; it costs every turn its bytes too.',
    '',
    tools,
    '',
    'Recorded fact keys (`fact`): the durable world model. Propose one ONLY for a preference the',
    'user stated in their own words, and quote those words verbatim from a turn above; a fact whose',
    `quote is not in the trajectory is refused. ${FACT_SCOPE} The keys recorded now:`,
    factLines,
    '',
    'Skill files (`skill`): a procedure the agent follows when its description matches the work, and the last',
    'resort: only a multi-step procedure that no prompt section or tool description can carry. An accepted skill',
    'becomes trusted at the next turn whose prompt cache is cold, and the owner can revert it.',
    '',
    'Every description you write, for a skill or a tool, says when it applies, and when a similar one fits instead.',
    '',
    'Subagent specs (`subagent_spec`): a subagent\'s role and spec belong to that agent\'s',
    'own config and there is no writable proposal authority for them. Propose one only to record',
    'the finding; it will be refused rather than applied.',
    '',
    '## What earlier refinements did',
    '',
    history || '  (this is the first refinement)',
    '',
    DREAM_BRIEF_HEADINGS.watch,
    '',
    renderWatch(changeOwners(deps)) || '  (no earlier dream changed anything)',
    '',
    DREAM_BRIEF_HEADINGS.picks,
    '',
    picks || NO_CONFUSED_PICKS,
    '',
    '## The workspace\'s instruction files',
    '',
    await contextFiles(deps),
    '',
    DREAM_BRIEF_HEADINGS.answer,
    '',
    `One JSON object carrying exactly these keys: ${answerKeys}, and no others. Every level is`,
    'strict: a key that is not named here refuses the whole proposal rather than being dropped, so',
    'anything you want to say that is not one of these fields has no place to go. Each edit object',
    `carries exactly the keys its \`kind\` shows below, and every \`rationale\` is `
      + `${String(MIN_EDIT_RATIONALE)} characters or longer, whatever the kind.`,
    '',
    `\`scope\` is ${JSON.stringify(answer.scope)}: the scope this request was opened at. A proposal`,
    'at any other scope is refused without being routed.',
    '',
    `{"scope":${JSON.stringify(answer.scope)},"summary":${JSON.stringify(answer.summary)},"edits":[`,
    ...answer.edits.map((edit, index) =>
      `  ${JSON.stringify(edit)}${index === answer.edits.length - 1 ? '' : ','}`),
    ']}',
    '',
    `Valid \`kind\` values: ${REFINEMENT_EDIT_KINDS.join(', ')}. The ${String(answer.edits.length)} edits above are every shape`,
    'this accepts, one object per edit, not a checklist. Propose the fewest edits that address the',
    'pattern you actually found. An empty `edits` array is a legitimate answer when the trajectory',
    'shows no addressable pattern.',
    '',
    jsonObjectOnlyInstruction(),
  ].join('\n');
}

/** What earlier dreams did, each edit with where it went: the context both of a dream's agents read. */
function dreamHistory(sql: SqlExecutor, actor: ActorHandle, request: RefinementRequest): string {
  return createRefinementStore(sql, actor).list(5)
    .filter((prior) => prior.id !== request.id)
    .map((prior) => `  - ${prior.id} (${prior.trigger}, ${prior.stage}): ${prior.detail || '(no detail)'}`
      + prior.routes.map((r) => `\n      ${r.kind} -> ${r.owner || 'no owner'} ${r.target} [${r.disposition}]`).join(''))
    .join('\n');
}

function draftedText(edit: RefinementEdit): string {
  switch (edit.kind) {
    case 'fact': return JSON.stringify(edit.value);
    case 'subagent_spec': return edit.spec;
    case 'prompt_section':
    case 'tool_description':
    case 'skill': return edit.source;
  }
}

/** One drafted edit as the reviewer reads it: what it changes, why, the whole new text, and what it was measured at. */
function renderDraftedEdit(edit: RefinementEdit, index: number, evidence: EditEvidence | undefined): string {
  const [owner, target] = editOwnerAndTarget(edit);
  const body = draftedText(edit);

  return [
    `### Edit ${String(index)}: ${edit.kind} ${target} (${owner || 'no owner'})`,
    `Why: ${edit.rationale}`,
    `New text:\n${body}`,
    evidence?.refused === undefined ? `Measured: ${evidence?.note ?? '(not measured)'}` : `Refused by a fixed gate, whatever you say: ${evidence.refused}`,
  ].join('\n');
}

/** Every text a turn reads that a dream may edit: the prompt sections, and each built-in tool's description and field text. */
function evolvableTexts(): string[] {
  return [
    ...PROMPT_SECTIONS.map((section) => sectionArtifact(section.id)),
    ...Object.keys(BUILTIN_TOOL_DESCRIPTIONS).flatMap((tool) => [toolArtifact(tool, 'description'), toolArtifact(tool, 'schema')]),
  ];
}

/**
 * The reviewer's brief: the turns, earlier dreams, every drafted edit with its measured evidence, the size budget, and
 * the answer shape. Its answer decides which edits are routed.
 */
async function renderReviewerBrief(
  deps: RefinementDeps,
  request: RefinementRequest,
  input: { readonly proposal: RefinementProposal; readonly evidence: readonly EditEvidence[]; readonly reviewed: readonly TurnRating[] },
): Promise<string> {
  const { sql, rt } = deps.control;
  const bytes = (text: string | null): number => Buffer.byteLength(text ?? '', 'utf8');
  const bundled = evolvableTexts().reduce((total, artifactId) => total + bytes(bundledArtifact(artifactId)), 0);
  const current = evolvableTexts().reduce((total, artifactId) => total + bytes(artifactBody(sql, rt.actor, artifactId)), 0);
  const example: v.InferInput<typeof DreamVerdictsSchema> = { verdicts: [{ edit: 0, verdict: 'accept', note: '<one sentence: why>' }] };

  return [
    'Another agent read this agent\'s recent turns and drafted the edits below to how it works. You judge them for',
    'quality (is it right, and in the right place), effectiveness (would it have changed the turns that went wrong,',
    'without harming the ones that went well) and size (does it earn every byte it adds to every future turn).',
    'Accept no edit its evidence does not support, and rewrite none yourself.',
    '',
    EDIT_PRIORITY,
    'Reject a skill that an edit to a prompt section or a tool description would cover.',
    `Reject a fact that does not hold to this: ${FACT_SCOPE}`,
    '',
    `## The turns it read (${String(input.reviewed.length)})`,
    '',
    input.reviewed.map((row, index) => renderReviewedTurn(row, index)).join('\n\n') || '(none)',
    '',
    '## What earlier dreams did',
    '',
    dreamHistory(sql, rt.actor, request) || '  (this is the first dream)',
    '',
    DREAM_BRIEF_HEADINGS.watch,
    '',
    renderWatch(changeOwners(deps)) || '  (no earlier dream changed anything)',
    '',
    DREAM_BRIEF_HEADINGS.picks,
    '',
    await picksSection(deps, input.reviewed) || NO_CONFUSED_PICKS,
    '',
    '## The drafted edits',
    '',
    input.proposal.edits.map((edit, index) => renderDraftedEdit(edit, index, input.evidence.find((measured) => measured.edit === index))).join('\n\n'),
    '',
    '## Size',
    '',
    `The prompt sections and tool texts are ${String(current)} bytes, against ${String(bundled)} as bundled. Their budget`,
    'is 10% over the bundled size, a placeholder until a measurement of prompt sizes against the cache\'s cost sets it:',
    'an edit that grows them past it must shrink something else.',
    '',
    DREAM_BRIEF_HEADINGS.answer,
    '',
    'One JSON object with one verdict per edit, by its number: `accept` routes it, `reject` drops it, and `revise`',
    'sends it back to its author once with your note, after which you judge it again. Every verdict carries a note.',
    '',
    JSON.stringify(example),
    '',
    jsonObjectOnlyInstruction(),
  ].join('\n');
}

/** The dreamer's one revision: its own brief again, its proposal, and the reviewer's verdicts on it. */
async function renderReviseBrief(
  deps: RefinementDeps,
  request: RefinementRequest,
  input: { readonly proposal: RefinementProposal; readonly verdicts: readonly DreamVerdict[] },
): Promise<string> {
  const brief = await renderRefinerBrief(deps, request);

  return [
    brief,
    '',
    '## Your earlier proposal, and the reviewer\'s verdicts on it',
    '',
    JSON.stringify(input.proposal),
    '',
    ...input.verdicts.map((verdict) => `- Edit ${String(verdict.edit)}: ${verdict.verdict}: ${verdict.note}`),
    '',
    'Answer with the whole proposal again, in the same shape: keep the edits it accepted as they are, revise those it',
    'asked you to revise, and drop those it rejected. This is your one revision.',
  ].join('\n');
}

const NO_CONFUSED_PICKS = '  (no turn here switched picks, or was corrected after one)';

/** Discovery reads no skill file larger than this; a larger one is named as no skill. */
const PICKED_SKILL_TOKENS = 64_000;

/** The turns' confused picks, each named with its description now: a skill's only where it is built in or trusted. */
async function picksSection(deps: RefinementDeps, reviewed: readonly TurnRating[]): Promise<string> {
  const confused = confusedPicks(reviewed);

  if (confused.switches.length === 0 && confused.corrected.length === 0) return '';
  const { approvals } = deps;
  const trust: InstructionTrustResolver = approvals === undefined ? () => 'unverified' : (path, content) => approvals.trustOf(path, content);
  const discovery = await discoverSkills(deps.skillsVfs, { admissionTokens: PICKED_SKILL_TOKENS, trust });
  const skills = new Map(discovery.skills.map((skill) => [skill.name, skill] as const));

  return renderConfusedPicks(confused, (kind, name) => {
    if (kind === 'tool') return deps.control.rt.craftStore.get(name)?.description ?? '(no crafted tool has this name now)';
    const skill = skills.get(name);

    if (skill === undefined) return '(no skill has this name now)';

    return skill.bodyRef.kind === 'builtin' || skill.trusted === true ? skill.description : '(not trusted, so its description is withheld)';
  });
}

function renderReviewedTurn(row: TurnRating, index: number): string {
  return [
    `### Turn ${String(index + 1)}: rated ${row.score.toFixed(1)}/5 (${row.source})`
      + (row.wrong !== null && row.wrong !== 'nothing' ? `: ${row.wrong.replaceAll('_', ' ')}` : ''),
    `User asked: ${evidenceWindow(row.request, EVIDENCE_BUDGETS.refinerUserMessage)}`,
    `Agent answered: ${evidenceWindow(row.answer, EVIDENCE_BUDGETS.refinerAssistantResponse)}`,
    row.followup === null
      ? 'User follow-up: (none)'
      : `User follow-up: ${evidenceWindow(row.followup, EVIDENCE_BUDGETS.refinerFollowup)}`,
  ].filter((line) => line !== '').join('\n');
}

/** Hand one typed edit to its owning authority; the route stores only a pointer
 *  to the identity there, so the two rows cannot disagree. */
function routeEdit(
  deps: RefinementDeps,
  input: {
    edit: RefinementEdit;
    request: RefinementRequest;
    reviewed: readonly TurnRating[];
    /** A section's judge-only numbers, measured before the reviewer accepted it. */
    artifact?: ArtifactEvidence;
  },
): Effect.Effect<RefinementRoute> {
  const { edit } = input;

  return attempt({ doing: `routing the ${edit.kind} edit`, otherwise: 'io' }, () => routeEditOnce(deps, input)).pipe(
    Effect.catch((failure) => Effect.sync((): RefinementRoute => {
      const [owner, target] = editOwnerAndTarget(edit);

      return { kind: edit.kind, owner, target, disposition: 'refused', reason: renderThrownChain({ cause: failure }) };
    })),
  );
}

function editOwnerAndTarget(edit: RefinementEdit): readonly [string, string] {
  switch (edit.kind) {
    case 'fact': return ['agent_facts', edit.key];
    case 'prompt_section': return ['artifact_versions', sectionArtifact(edit.sectionId)];
    case 'tool_description': return ['artifact_versions', toolArtifact(edit.tool, edit.part)];
    case 'skill': return ['instruction_approvals', edit.path];
    case 'subagent_spec': return ['', edit.role];
  }
}

async function routeEditOnce(
  deps: RefinementDeps,
  input: Parameters<typeof routeEdit>[1],
): Promise<RefinementRoute> {
  const { edit } = input;

  switch (edit.kind) {
    case 'fact':
      return routeFact(deps, edit, input.request, input.reviewed);
    case 'prompt_section':
    case 'tool_description':
      return routeArtifactEdit(deps, edit, input.artifact);
    case 'skill':
      return routeSkill(deps, edit, input.request);
    case 'subagent_spec':
      return { kind: 'subagent_spec', owner: '', target: edit.role, disposition: 'refused', reason: SUBAGENT_SPEC_REFUSAL };
  }
}

const SUBAGENT_SPEC_REFUSAL = 'no writable proposal authority exists for a subagent\'s role or spec: those '
  + 'belong to that agent\'s own config, which this workspace reads and never writes. '
  + 'Recorded as a finding rather than mirrored into a second agent store.';

/** A quote must be a real fragment, not a common token: "keep it short please"
 *  is the floor. */
const MIN_QUOTE_CHARS = 20;

const MIN_QUOTE_WORDS = 4;

/** User words only (message and follow-up): an agent-sourced preference would
 *  be the agent writing its own instructions. */
function userEvidence(row: TurnRating): string {
  return `${row.request}\n${row.followup ?? ''}`;
}

function checkQuote(quote: string, reviewed: readonly TurnRating[]): Result.Result<void, string> {
  const trimmed = quote.trim();
  const words = trimmed.split(/\s+/u).filter((word) => word !== '');

  if (trimmed.length < MIN_QUOTE_CHARS || words.length < MIN_QUOTE_WORDS) {
    return Result.fail(`the quote is not substantive: ${String(trimmed.length)} characters and `
      + `${String(words.length)} words, below the ${String(MIN_QUOTE_CHARS)}-character and `
      + `${String(MIN_QUOTE_WORDS)}-word floor. A fragment that short matches almost any `
      + 'conversation, so it is evidence of nothing');
  }

  // Whitespace-normalised and case-insensitive (the ledger re-wraps what it
  // stored); the user's words must still appear in order.
  const needle = trimmed.replace(/\s+/gu, ' ').toLowerCase();

  const said = reviewed.some((row) =>
    userEvidence(row).replace(/\s+/gu, ' ').toLowerCase().includes(needle));

  if (!said) {
    return Result.fail('not quoted by the user anywhere in the reviewed trajectory: a preference reaches '
      + "memory immediately, so the user's own words are the only evidence that can stand in "
      + 'for a judge');
  }

  return Result.void;
}

/**
 * The one immediate write: no judge of recorded turns can weigh a user preference, so
 * {@link checkQuote} is the gate. Idempotent via the keyed `FactsStore.upsert`.
 * The quote rides the route into the changelog.
 */
function routeFact(
  deps: RefinementDeps,
  edit: Extract<RefinementEdit, { kind: 'fact' }>,
  request: RefinementRequest,
  reviewed: readonly TurnRating[],
): RefinementRoute {
  const verdict = checkQuote(edit.quote, reviewed);

  if (Result.isFailure(verdict)) {
    return {
      kind: 'fact', owner: 'agent_facts', target: edit.key,
      disposition: 'refused', reason: verdict.failure,
    };
  }

  const outcome = deps.facts.upsert(edit.key, edit.value, { source: `refinement:${request.id}`, origin: { by: 'background' } });

  if (outcome !== 'unchanged') diagnostics.event('dream.fact_applied', { change: edit.key, dream: request.id });

  return {
    kind: 'fact',
    owner: 'agent_facts',
    target: edit.key,
    disposition: 'applied',
    reason: `${outcome === 'unchanged' ? 'already recorded' : outcome} from the user's own words `
      + `"${edit.quote.trim().replace(/\s+/gu, ' ')}": ${edit.rationale}`,
  };
}

/**
 * A section or tool text the reviewer accepted is staged for the next turn whose prompt cache is cold, with the numbers
 * it was measured by. A resumed pass adopts a staged version with the same words instead of writing a second one.
 */
function routeArtifactEdit(
  deps: RefinementDeps,
  edit: Extract<RefinementEdit, { kind: 'prompt_section' | 'tool_description' }>,
  artifact: ArtifactEvidence | undefined,
): RefinementRoute {
  const [owner, artifactId] = editOwnerAndTarget(edit);
  const { sql, rt } = deps.control;

  const staged = (version: number, note: string): RefinementRoute => ({
    kind: edit.kind, owner, target: `${artifactId}@${String(version)}`, disposition: 'staged',
    reason: `${note}; the live prompt moves at the next turn whose prompt cache is cold`,
  });

  const already = listArtifactVersions(sql, rt.actor, artifactId)
    .find((version) => version.status === 'staged' && version.body === edit.source);

  if (already !== undefined) return staged(already.version, 'staged (adopted from an earlier pass)');

  if (artifact === undefined) return { kind: edit.kind, owner, target: artifactId, disposition: 'refused', reason: 'it was never measured' };

  return staged(stageArtifact(sql, rt.actor, { artifactId, body: edit.source, rationale: edit.rationale, evidence: artifact }), 'accepted by the dream\'s reviewer');
}

/** Applied when any artifact is in effect: a live fact plus a reverted section
 *  is still a changed agent. */
function settledStage(landed: number, undone: number): RefinementStage {
  if (landed > 0) return 'applied';

  if (undone > 0) return 'rolled_back';

  return 'refused';
}

/**
 * Derive the verdict from the owners (section store, approval store), never
 * from callbacks, so it cannot drift. Null while anything is pending or when
 * the guarded transition finds the row already moved.
 */
/** A section edit is pending until a cold turn makes it current, or the owner discards it. */
/** A staged text or skill edit's state, as its owner holds it; null for any other route. */
async function stagedRouteState(
  deps: RefinementDeps, owners: ChangeOwners, request: RefinementRequest, route: RefinementRoute,
): Promise<Awaited<ReturnType<typeof settleDreamSkill>> | null> {
  if (route.disposition !== 'staged') return null;

  if (route.kind === 'skill') return await settleDreamSkill(deps, request, route);

  if (route.owner !== 'artifact_versions') return null;
  const standing = changeStanding(owners, deps.facts, { request, route })?.standing;

  if (standing === 'reverted') return { state: 'rolled_back' };

  return { state: standing === 'in_effect' || standing === 'replaced' ? 'applied' : 'pending' };
}

async function settleRoutes(
  deps: RefinementDeps,
  request: RefinementRequest,
): Promise<RefinementRequestView | null> {
  const owners = changeOwners(deps);
  let promoted = 0;
  let rolledBack = 0;
  let rejected = 0;
  let pending = 0;
  const blocked: string[] = [];
  // Facts have no pending state left to read.
  const alreadyApplied = request.routes.filter((route) => route.disposition === 'applied').length;
  // Owner rejections are distinct from gate refusals (see REFINEMENT_DISPOSITIONS).
  rejected = request.routes.filter((route) => route.disposition === 'rejected').length;

  for (const route of request.routes) {
    const settled = await stagedRouteState(deps, owners, request, route);

    if (settled === null) continue;

    if (settled.state === 'pending') {
      pending += 1;

      // A promotion that cannot complete stays pending with its reason shown.
      if (settled.reason !== undefined) blocked.push(settled.reason);
    } else if (settled.state === 'rolled_back') rolledBack += 1;
    else promoted += 1;
  }

  const store = createRefinementStore(deps.control.sql, deps.control.rt.actor);

  if (pending > 0) {
    const waiting = `${String(pending)} edit${pending === 1 ? '' : 's'} waiting for a turn whose prompt cache is cold`
      + (blocked.length > 0 ? ` · ${blocked.join(' · ')}` : '');

    if (request.stage === 'evaluating') {
      // No transition, but record a blocked promotion's reason in place so it
      // is not hidden behind the wait.
      if (blocked.length === 0 || request.detail === waiting) return null;
      store.record(request.id, 'evaluating', { detail: waiting });

      return refinementRequestView(store.get(request.id) ?? request);
    }

    if (!store.advance(request.id, 'gated', 'evaluating', { detail: waiting })) return null;

    return refinementRequestView(store.get(request.id) ?? request);
  }

  const stage = settledStage(promoted + alreadyApplied, rolledBack + rejected);
  const parts: string[] = [];

  if (promoted > 0) {
    parts.push(`${String(promoted)} proposal${promoted === 1 ? '' : 's'} in effect on their `
      + "owners' own evidence");
  }

  if (alreadyApplied > 0) {
    parts.push(`${String(alreadyApplied)} edit${alreadyApplied === 1 ? '' : 's'} in effect: `
      + "preferences from the user's own words");
  }

  if (rolledBack > 0) {
    parts.push(`${String(rolledBack)} rolled back`);
  }

  if (rejected > 0) parts.push(`${String(rejected)} rejected by you`);

  if (parts.length === 0) parts.push('every proposed edit was refused');
  const from: RefinementStage = request.stage === 'gated' ? 'gated' : 'evaluating';

  if (!store.advance(request.id, from, stage, { detail: parts.join('; ') })) return null;

  return refinementRequestView(store.get(request.id) ?? request);
}
