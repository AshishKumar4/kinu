// THE REFINEMENT LANE — the driver that turns a captured trajectory into typed
// edits sitting in the authorities that already own them.
//
// Two public entry points and nothing else:
//
//   requestRefinement    — capture the trajectory, open the durable row, return.
//                          NO model call, NO write to any artifact. This is what
//                          `/refine` answers with, and what the automatic
//                          trigger opens.
//   advanceRefinementLane— one step of the machine: run the refiner for the
//                          oldest owed request, route what it proposes, or settle
//                          a request whose owner has since decided.
//
// The split is the crash story. A request that returns before any model runs is
// a request a dead process cannot lose, and a refiner that runs on the cadence
// lane rather than on the user's turn can be re-driven for free — it is READ
// ONLY. `resetStalePlanning` is therefore the whole recovery: no compensation to
// write, nothing to un-apply, no deadline to pick.
//
// WHY THE REFINER IS A TEMPORARY AGENT. The trajectory, the artifact inventory
// and the prior refinements are more material than a turn should pay to hold, and
// the answer needed from them is one object. `agents.ask` is exactly that shape:
// a child reads the referenced files itself, answers once, and is released with
// its transcript kept. It has no write authority here — the proposal comes back
// as prose, this module parses it, and every write is made by THIS code against
// a named owner. A refiner that could write would be a second authority for
// every artifact it touched.
//
// WHY NOTHING HERE PROMOTES. `proposeMeasuredPromptSection` lands a section
// PENDING and `advancePromptSectionLane` decides it on held-out trials; a skill's
// bytes stay `unverified` until the owner approves that exact digest; a subagent
// spec has no writable authority and is refused by name. The one immediate write
// is a fact, and the thing standing in for a trial there is the user's own
// sentence — checked against the reviewed turns, not taken on the refiner's word.

import * as v from 'valibot';

import { proposeMeasuredPromptSection } from './control';
import { buildOutcomeEvalSplit } from './eval-split';
import {
  describeSplitDegeneracy, listTurnOutcomes, type TurnOutcomeRow,
} from './outcomes';
import {
  REFINEMENT_EDIT_KINDS, RefinementProposalSchema, createRefinementStore, evolutionDebt,
  refinementRequestView,
  type RefinementClaim, type RefinementDeps,
  type EvolutionDebt, type RefinementEdit, type RefinementProposal, type RefinementRequest,
  type RefinementRequestView, type RefinementRoute, type RefinementScope, type RefinementStage,
  type RefinementTrigger, type SettleRefinementPatch,
} from './refinement';
import { clampGepaEvalBudget } from '../config/store';
import { getPendingPromptSection, listPromptSectionVersions } from '../prompting/section-store';
import { PROMPT_SECTIONS } from '../prompting/section-templates';
import { routeSkill, settleSkillApproval } from './refinement-skill';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import { renderThrownChain, tolerate } from '../obs/index';
import type { SqlExecutor } from '../types/primitives';


export interface RequestRefinementInput {
  readonly trigger: RefinementTrigger;
  readonly scope: RefinementScope;
  readonly sessionId?: string;
  /** The trajectory to review. Omitted = the unresolved negative outcomes this
   *  workspace has accrued, which is what `/refine` with no argument means. */
  readonly turnIds?: readonly string[];
  readonly debtKey?: string;
}

/**
 * Why no authority here can serve an account-scoped refinement.
 *
 * Stated once, and used both when the REQUEST is opened at that scope and when
 * the refiner claims it, so an owner reads the same sentence either way.
 */
const ACCOUNT_SCOPE_REFUSAL =
  'account scope is refused: every authority reachable from a workspace database '
  + '(agent_facts, prompt_section_versions, instruction_approvals) is scoped to THIS '
  + 'workspace, so there is nothing here that can write account-wide state. Applying '
  + 'it to one workspace instead would put a preference somewhere the owner did not ask for.';

/**
 * Open one refinement request.
 *
 * Returns the durable row, at `requested`, having changed no behaviour and
 * called no model.
 *
 * TWO conditions are refused HERE rather than after the refiner has run, because
 * both are known before a model is worth spending:
 *
 *   • an account-scoped request, which no authority here can serve at all;
 *   • a trajectory with nothing graded in it, since a refiner shown no outcomes
 *     would be asked to invent a complaint and the section gate downstream would
 *     refuse the result anyway.
 *
 * Both leave a DURABLE refused row rather than throwing: the owner asked, and the
 * answer is part of the record.
 */
export async function requestRefinement(
  deps: RefinementDeps,
  input: RequestRefinementInput,
): Promise<RefinementRequestView> {
  const sql = deps.control.sql;
  const store = createRefinementStore(sql);
  const turnIds = input.turnIds ?? evolutionDebt(sql).turnIds;
  // The ledger reads newest-first; a trajectory is read forwards. Keep the
  // caller's order and let the ledger only decide which of those turns is
  // actually graded, so the stored trajectory is the one the brief renders and
  // the debt derivation named.
  const graded = new Set(
    listTurnOutcomes(sql, { turnIds })
      .map((row) => row.turnId)
      .filter((id): id is string => id !== null),
  );
  const reviewed = turnIds.filter((id) => graded.has(id));

  let requestInput: Parameters<typeof store.open>[0] = {
    trigger: input.trigger,
    scope: input.scope,
    turnIds: reviewed,
  };
  if (input.sessionId !== undefined) {
    requestInput = { ...requestInput, sessionId: input.sessionId };
  }
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
      ? describeSplitDegeneracy('no_labeled_turns')
      : `${describeSplitDegeneracy('no_labeled_turns')} — none of the ${String(turnIds.length)} `
        + 'named turns carries an outcome');
  }
  return refinementRequestView(request);
}

/**
 * The automatic trigger: open a request for the accumulated evolution debt, or
 * answer null when nothing is owed.
 *
 * Safe to call on every cadence tick. The batch's own identity is its
 * idempotency key, so a tick that re-derives the same unresolved failures finds
 * the request it already opened instead of opening a second one — and a batch
 * that has been taken stops counting as debt, so the next tick sees only what
 * happened since.
 */
export async function refinementDebtRequest(
  deps: RefinementDeps,
): Promise<RefinementRequestView | null> {
  const debt = evolutionDebt(deps.control.sql);
  if (!debt.owed) return null;
  return requestRefinement(deps, {
    trigger: 'evolution_debt',
    scope: 'workspace',
    turnIds: debt.turnIds,
    debtKey: debt.key,
  });
}

/** The accumulated debt, for the surfaces that show it. Re-exported here so a
 *  host wires one module rather than two for one capability. */
export function refinementDebt(deps: RefinementDeps): EvolutionDebt {
  return evolutionDebt(deps.control.sql);
}

/** What one step of the lane did. */
export type RefinementLaneStep =
  /** A request was planned: the refiner ran and its edits were routed. */
  | { readonly step: 'planned'; readonly request: RefinementRequestView }
  /** A request waiting on an owner reached its verdict. */
  | { readonly step: 'settled'; readonly request: RefinementRequestView }
  /** Nothing is owed, or this host cannot run a refiner. */
  | { readonly step: 'idle' };

/**
 * Advance the refinement loop by one step.
 *
 * A request waiting on an owner is SETTLED first, always: a proposal whose owner
 * has already decided is a verdict nobody has recorded yet, and recording it is
 * free where running a refiner costs a child agent. With nothing to settle, the
 * oldest owed request gets its refiner run.
 *
 * The claim is what makes two of these safe at once, and both hosts can deliver
 * two: the cloud backend nudges this lane from the `/refine` callable while the
 * cadence pass drives it, and the CLI does the same. The second caller finds the
 * row claimed, claims nothing, and reports `idle` — one refiner, one set of
 * owner writes, one route set.
 *
 * RECOVERY RUNS FIRST, on every pass rather than only when an engine is built.
 * A planner that threw — a child-agent host that went away mid-call — released
 * its claim on the way out and left the row `planning` with a token nothing is
 * executing. Waiting for the next activation to notice would park that request
 * for the rest of the process's life. The re-queue skips tokens this process is
 * still running, so a pass in flight beside this one is never disturbed.
 */
export async function advanceRefinementLane(
  deps: RefinementDeps,
): Promise<RefinementLaneStep> {
  const store = createRefinementStore(deps.control.sql);
  store.resetStalePlanning();
  // BOTH stages, and `gated` is the one that matters. A host killed between
  // routing and the settle inside `plan` leaves the row at `gated` with every
  // route made; a scan that only looked at `evaluating` would never come back
  // for it, and the request would sit there with a live fact and a pending
  // section that nothing ever reconciled.
  for (const waiting of store.settleable()) {
    const settled = await settleRoutes(deps, waiting);
    if (settled) return { step: 'settled', request: settled };
  }
  const owed = store.nextRequested();
  if (!owed || !deps.refiner) return { step: 'idle' };
  const claimed = store.claim(owed.id);
  if (!claimed) return { step: 'idle' };
  try {
    const planned = await plan(deps, claimed);
    // Null is a pass that lost its claim to recovery: it wrote nothing, so it
    // planned nothing, and saying otherwise would report the SUCCESSOR's work.
    return planned === null ? { step: 'idle' } : { step: 'planned', request: planned };
  } finally {
    // This pass is over however it ended. A claim left registered after the pass
    // stopped would make recovery in this process skip a row nothing is driving.
    claimed.release();
  }
}

/**
 * Whether this route's disposition is one only the OWNER could have written.
 *
 * `applied` on a skill and `rejected` anywhere are owner acts
 * (`decideRefinementRoute`); a gate cannot produce either. `applied` on a fact
 * is a routing act, but re-routing one is harmless — the keyed store reports
 * `unchanged` — so treating it as decided costs nothing and keeps the predicate
 * one sentence rather than a per-kind table.
 */
function ownerHasDecided(route: RefinementRoute): boolean {
  return route.disposition === 'applied' || route.disposition === 'rejected';
}

/**
 * The request's trajectory in READING order.
 *
 * `listTurnOutcomes` answers newest-first, which is right for a digest and wrong
 * for a trajectory: the refiner is being asked what went wrong over time, and a
 * conversation shown backwards invites a causal story that runs the other way.
 */
function reviewedTrajectory(sql: SqlExecutor, request: RefinementRequest): TurnOutcomeRow[] {
  const byId = new Map(
    listTurnOutcomes(sql, { turnIds: request.turnIds })
      .map((row) => [row.turnId, row] as const),
  );
  return request.turnIds
    .map((id) => byId.get(id))
    .filter((row): row is TurnOutcomeRow => row !== undefined);
}

/**
 * Run the refiner for one claimed request, persist its proposal, route its
 * edits, and settle the stage. Null when this pass lost the claim: it wrote
 * nothing and the request belongs to whoever holds it now.
 *
 * THE PROPOSAL IS PERSISTED BEFORE THE FIRST OWNER WRITE, and that ordering is
 * the crash story. Routing makes real writes — a fact upsert, a section
 * proposal, a skill file — so a process that dies between two of them has
 * already changed the workspace. If the proposal were only written at the end,
 * the recovered request would have no record of what it was doing and would ask
 * the refiner again, whose fresh answer need not resemble the writes already on
 * disk. Persisting first turns the row into the plan: `resume` re-routes exactly
 * the same edits, and every route ADOPTS the owner record it finds rather than
 * making a second one.
 *
 * THE CLAIM IS READ BEFORE EVERY OWNER WRITE, and that is the other half. The
 * owners are other stores and cannot be guarded from the request row, so the
 * last moment a revoked pass can be stopped is before it writes to one. Without
 * it, a recovery that re-queued this claim while the refiner was still running
 * would leave two passes routing two different answers into one request's
 * owners — a fact under a key the row never records, staged bytes the recorded
 * digest no longer describes.
 *
 * `gated` is a real stage, not a synonym for "done": routing ends there, and
 * `settleRoutes` immediately reads the owners to decide whether anything is
 * genuinely pending. A fact-only proposal therefore reaches `applied` in the
 * same pass instead of parking in `gated` forever with nothing to wait for.
 */
async function plan(
  deps: RefinementDeps,
  claim: RefinementClaim,
): Promise<RefinementRequestView | null> {
  const { request } = claim;
  const store = createRefinementStore(deps.control.sql);
  const view = (): RefinementRequestView =>
    refinementRequestView(store.get(request.id) ?? request);
  const refuse = (detail: string, rejected?: RefinementProposal): RefinementRequestView | null => {
    let patch: SettleRefinementPatch = { detail };
    if (rejected !== undefined) patch = { ...patch, proposal: rejected, routes: [] };
    if (!claim.advance('refused', patch)) return null;
    return view();
  };

  // A resumed claim already has its plan. Re-asking would spend a second child
  // agent to get a different plan than the writes already on disk belong to.
  let proposal = request.proposal;
  if (proposal === null) {
    const answered = await askRefiner(deps, request);
    if (!answered.ok) return refuse(answered.error);
    proposal = answered.proposal;
  }

  if (proposal.scope !== request.scope) {
    return refuse(
      `the refiner proposed at ${proposal.scope} scope and this request is ${request.scope} scope — `
      + (proposal.scope === 'account' ? ACCOUNT_SCOPE_REFUSAL : 'the scopes must match'),
      proposal,
    );
  }
  if (proposal.edits.length === 0) {
    return refuse(`the refiner proposed no edits — ${proposal.summary}`, proposal);
  }

  // THE WRITE THAT MAKES THE REST RECOVERABLE. Stage stays `planning`; only the
  // plan lands, before any owner has been touched. It is also the first fence:
  // a claim revoked while the refiner ran fails here, before the plan can
  // overwrite the one the holder is routing.
  if (request.proposal === null
    && !claim.record({ proposal, detail: proposal.summary })) return null;

  const reviewed = reviewedTrajectory(deps.control.sql, request);
  const routes: RefinementRoute[] = [];
  for (const [index, edit] of proposal.edits.entries()) {
    // A DECIDED route is never re-routed. A resumed pass re-runs the plan, and
    // re-routing a skill the owner already approved or rejected would replace
    // their answer with a fresh `pending_owner_approval` — asking them again
    // about bytes they have already settled, and in the approve case silently
    // un-applying a promotion that really happened. The owner's word outlives a
    // crash; only an undecided route is this pass's to make again.
    const decided = request.routes[index];
    if (decided !== undefined && ownerHasDecided(decided)) {
      routes.push(decided);
      continue;
    }
    if (!claim.held()) return null;
    routes.push(await route(deps, { edit, request, reviewed }));
    // Persisted AFTER EACH route, not once at the end: a crash between two
    // owner writes must leave the completed ones recorded, or the resumed pass
    // would report a change it cannot see and the changelog would omit an edit
    // the workspace is actually carrying.
    if (!claim.record({ routes })) return null;
  }

  if (!claim.advance('gated', { routes, detail: proposal.summary })) return null;
  return await settleRoutes(deps, store.get(request.id) ?? request) ?? view();
}

// ── The refiner ──────────────────────────────────────────────────────────────

type RefinerAnswer =
  | { readonly ok: true; readonly proposal: RefinementProposal }
  | { readonly ok: false; readonly error: string };

/** Workspace instruction files a refiner may read ITSELF, when this workspace
 *  has them.
 *
 *  Named rather than globbed: these are the files whose CONTENT a proposal has
 *  to be written against, and the channel exists so their bytes never enter a
 *  parent's window. The memory file is at the path genesis writes it
 *  (`identity/create.ts`: `memory/MEMORY.md`); `AGENTS.md` exists only in a
 *  workspace whose owner wrote one. The port refuses an absent path BY NAME
 *  rather than truncating, so a candidate is offered only after this
 *  workspace's own filesystem says it is there — the lane used to name
 *  `MEMORY.md` at the root and `AGENTS.md` unconditionally, and every automatic
 *  refinement in a standard workspace was refused before the refiner started. */
const REFINER_CONTEXT_CANDIDATES: readonly string[] = ['memory/MEMORY.md', 'AGENTS.md'];

async function presentContextRefs(deps: RefinementDeps): Promise<string[]> {
  const vfs = deps.control.rt.storage.vfs;
  const present: string[] = [];
  for (const path of REFINER_CONTEXT_CANDIDATES) {
    if (await vfs.exists(path)) present.push(path);
  }
  return present;
}

async function askRefiner(
  deps: RefinementDeps,
  request: RefinementRequest,
): Promise<RefinerAnswer> {
  const refiner = deps.refiner;
  if (!refiner) return { ok: false, error: 'this host wires no refiner' };
  const contextRefs = await presentContextRefs(deps);
  const outcome = await refiner.run({
    role: 'general',
    roleLabel: 'refiner',
    task: renderRefinerBrief(deps, request, contextRefs),
    contextRefs,
    // PLAN mode, and structurally: a refiner that could write would be a second
    // authority for every artifact it reviewed.
    mode: 'plan',
  });
  if (!('status' in outcome)) {
    return { ok: false, error: `the refiner could not start — ${outcome.error}` };
  }
  if (outcome.status !== 'completed') {
    return {
      ok: false,
      error: `the refiner did not answer (${outcome.reason ?? 'unknown'}) — ${outcome.answer}`,
    };
  }
  const parsed = v.safeParse(
    RefinementProposalSchema,
    tolerate(() => extractJsonObject(outcome.answer), 'malformed-input'),
  );
  if (!parsed.success) {
    return {
      ok: false,
      error: 'the refiner\'s answer is not a valid refinement proposal — '
        + parsed.issues.map((issue) => issue.message).join('; '),
    };
  }
  return { ok: true, proposal: parsed.output };
}

/**
 * The refiner's brief: the trajectory it may reflect on, the artifacts it may
 * address, what earlier refinements already did, and the one shape it must
 * answer in.
 *
 * THE HELD-OUT HALF IS WITHHELD, and that is what makes the trials downstream
 * mean anything. `buildOutcomeEvalSplit` divides the labelled turns into a train
 * half — the failures reflection is meant to fix — and a val half that
 * `proposeMeasuredPromptSection` and `runPromptSectionTrials` score candidates
 * on. A refiner shown the val turns writes wording aimed at the exact turns its
 * own proposal will be graded against, and the "measured improvement" that
 * follows is the proposal having memorised its own exam. GEPA obeys this split
 * (`runSectionGepa` takes `trainSet` for reflection and `evalSet` for
 * selection); a refinement that ignored it would be the one proposal generator
 * allowed to cheat.
 *
 * So the trajectory is intersected with the train half. A request whose turns are
 * ALL held out is shown none of them and says so — an honest empty brief, which
 * the refiner answers with no edits, rather than a leak.
 *
 * Every section is BOUNDED by the same `EVIDENCE_BUDGETS` every other reader of
 * this ledger uses, so a refiner cannot be handed more of a turn than the judge
 * that graded it saw.
 */
function renderRefinerBrief(deps: RefinementDeps, request: RefinementRequest, contextRefs: readonly string[]): string {
  const sql = deps.control.sql;
  const split = buildOutcomeEvalSplit(sql, clampGepaEvalBudget(deps.control.config.getGepaEvalBudget()));
  // The split's instances carry the turn's user message as `input`; that is the
  // only handle they share with the ledger rows, and it is what the section
  // metric is scored on, so it is the right thing to withhold by.
  const heldOut = new Set(split.val.map((instance) => instance.input));
  const reviewed = reviewedTrajectory(sql, request)
    .filter((row) => !heldOut.has(row.userMessage));
  const withheld = request.turnIds.length - reviewed.length;
  const trajectory = reviewed.map((row, index) => renderReviewedTurn(row, index)).join('\n\n');

  const sections = PROMPT_SECTIONS
    .map((section) => `  - ${section.id} (${String(Buffer.byteLength(section.source, 'utf8'))} bytes)`)
    .join('\n');
  const facts = deps.facts.recentTopK(20);
  const factLines = facts.length === 0
    ? '  (none recorded)'
    : facts.map((fact) => `  - ${fact.key}`).join('\n');

  const history = createRefinementStore(sql).list(5)
    .filter((prior) => prior.id !== request.id)
    .map((prior) => `  - ${prior.id} (${prior.trigger}, ${prior.stage}): ${prior.detail || '(no detail)'}`
      + prior.routes.map((r) => `\n      ${r.kind} → ${r.owner || 'no owner'} ${r.target} [${r.disposition}]`).join(''))
    .join('\n');

  return [
    'You are reviewing this agent\'s own recent failures to propose the SMALLEST typed edits',
    'that would have prevented them. You have no write access. Your answer is a proposal that',
    'deterministic gates and behavioural trials will decide on.',
    '',
    `## The trajectory under review (${String(reviewed.length)} graded turns)`,
    '',
    trajectory || '(no graded turns you may reflect on)',
    ...(withheld > 0
      ? ['', `${String(withheld)} further graded turn${withheld === 1 ? ' is' : 's are'} WITHHELD: `
        + 'they are the held-out set your proposal will be scored against, and showing them to you '
        + 'would let a proposal memorise its own exam.']
      : []),
    '',
    '## The artifacts you may address, and their owners',
    '',
    'Registered prompt sections (`prompt_section`) — replacing one costs every turn its bytes,',
    'and a longer section must earn them with a strictly better measured score:',
    sections,
    '',
    'Recorded fact keys (`fact`) — the durable world model. Propose one ONLY for a preference the',
    'user stated in their own words, and quote those words verbatim from a turn above; a fact whose',
    'quote is not in the trajectory is refused:',
    factLines,
    '',
    'Skill files (`skill`) — workspace instruction bytes. A proposed skill stays unverified and',
    'carries no tool policy until the owner approves its exact digest.',
    '',
    'Subordinate specs (`subagent_spec`) — a subordinate\'s role and spec belong to that agent\'s',
    'own config and there is no writable proposal authority for them. Propose one only to record',
    'the finding; it will be refused rather than applied.',
    '',
    '## What earlier refinements did',
    '',
    history || '  (this is the first refinement)',
    '',
    `## Files you may read yourself: ${contextRefs.length === 0 ? '(none in this workspace)' : contextRefs.join(', ')}`,
    '',
    '## Your answer',
    '',
    'One JSON object:',
    '',
    '{"scope":"workspace","summary":"<one sentence>","edits":[',
    '  {"kind":"fact","key":"<dotted.key>","value":<json>,"quote":"<the user\'s exact words>",'
      + '"rationale":"<why, at least 40 characters>"},',
    '  {"kind":"prompt_section","sectionId":"<registered id>","source":"<the whole replacement '
      + 'section, same template slots>","rationale":"..."},',
    '  {"kind":"skill","path":"/workspace/skills/<name>.md","source":"<the whole file>",'
      + '"rationale":"..."},',
    '  {"kind":"subagent_spec","role":"<role id>","spec":"<the change>","rationale":"..."}',
    ']}',
    '',
    `Valid \`kind\` values: ${REFINEMENT_EDIT_KINDS.join(', ')}. Propose the fewest edits that address`,
    'the pattern you actually found. An empty `edits` array is a legitimate answer when the',
    'trajectory shows no addressable pattern.',
    '',
    jsonObjectOnlyInstruction(),
  ].join('\n');
}

function renderReviewedTurn(row: TurnOutcomeRow, index: number): string {
  return [
    `### Turn ${String(index + 1)} — ${row.outcome} (${row.source})`,
    `User asked: ${evidenceWindow(row.userMessage, EVIDENCE_BUDGETS.refinerUserMessage)}`,
    `Agent answered: ${evidenceWindow(row.assistantResponse, EVIDENCE_BUDGETS.refinerAssistantResponse)}`,
    row.followup === null
      ? 'User follow-up: (none)'
      : `User follow-up: ${evidenceWindow(row.followup, EVIDENCE_BUDGETS.refinerFollowup)}`,
    row.evidence === null
      ? ''
      : `Why it was graded so: ${evidenceWindow(row.evidence, EVIDENCE_BUDGETS.storedEvidence)}`,
  ].filter((line) => line !== '').join('\n');
}

// ── Routing ──────────────────────────────────────────────────────────────────

/**
 * Hand one typed edit to the authority that owns it.
 *
 * Four arms, one per authority, and each returns the identity IN THAT
 * AUTHORITY. Nothing here stores an artifact: the route is a pointer, so the
 * refinement row and the owner's row can never disagree about what a proposal
 * became.
 */
async function route(
  deps: RefinementDeps,
  input: {
    edit: RefinementEdit;
    request: RefinementRequest;
    reviewed: readonly TurnOutcomeRow[];
  },
): Promise<RefinementRoute> {
  const { edit } = input;
  switch (edit.kind) {
    case 'fact':
      return routeFact(deps, edit, input.request, input.reviewed);
    case 'prompt_section':
      return routePromptSection(deps, edit);
    case 'skill':
      return routeSkill(deps, edit, input.request);
    case 'subagent_spec':
      return {
        kind: 'subagent_spec',
        owner: '',
        target: edit.role,
        disposition: 'refused',
        reason: 'no writable proposal authority exists for a subordinate\'s role or spec — those '
          + 'belong to that agent\'s own config, which this workspace reads and never writes. '
          + 'Recorded as a finding rather than mirrored into a second agent store.',
      };
  }
}

/**
 * What makes a quote EVIDENCE rather than a coincidence.
 *
 * A substring match alone is not a gate. "the", "ok" and "yes" appear in almost
 * any conversation, so a refiner could satisfy a naive check with a word it did
 * not have to earn and write any fact it liked. So a quote must be long enough
 * and specific enough to be something a person actually said about their
 * preference: a real sentence fragment, not a token.
 *
 * Twenty characters and four words, because that is the shortest genuine
 * instruction this gate exists to honour — "always answer in one line" is
 * twenty-six characters and five words, and "keep it short please" is the floor.
 * Below either bound the match carries no information about intent.
 */
const MIN_QUOTE_CHARS = 20;
const MIN_QUOTE_WORDS = 4;

/**
 * Where a quote has to come from.
 *
 * The USER's own words only: the assistant's response is the agent quoting
 * itself, and a preference sourced from the agent's own prose is the agent
 * writing its own future instructions. The follow-up counts because a
 * correction is exactly where a preference gets stated.
 */
function userEvidence(row: TurnOutcomeRow): string {
  return `${row.userMessage}\n${row.followup ?? ''}`;
}

type QuoteVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function checkQuote(quote: string, reviewed: readonly TurnOutcomeRow[]): QuoteVerdict {
  const trimmed = quote.trim();
  const words = trimmed.split(/\s+/u).filter((word) => word !== '');
  if (trimmed.length < MIN_QUOTE_CHARS || words.length < MIN_QUOTE_WORDS) {
    return {
      ok: false,
      reason: `the quote is not substantive — ${String(trimmed.length)} characters and `
        + `${String(words.length)} words, below the ${String(MIN_QUOTE_CHARS)}-character and `
        + `${String(MIN_QUOTE_WORDS)}-word floor. A fragment that short matches almost any `
        + 'conversation, so it is evidence of nothing',
    };
  }
  // Whitespace-normalised, case-insensitive: the ledger windows and re-wraps
  // what it stored, so requiring byte equality would refuse real quotes. The
  // WORDS still have to be the user's, in order.
  const needle = trimmed.replace(/\s+/gu, ' ').toLowerCase();
  const said = reviewed.some((row) =>
    userEvidence(row).replace(/\s+/gu, ' ').toLowerCase().includes(needle));
  if (!said) {
    return {
      ok: false,
      reason: 'not quoted by the user anywhere in the reviewed trajectory — a preference reaches '
        + "memory immediately, so the user's own words are the only evidence that can stand in "
        + 'for a trial',
    };
  }
  return { ok: true };
}

/**
 * The one immediate write, and what stands in for a trial.
 *
 * A preference is applied the moment it is proposed because a trial cannot
 * decide it — no judge knows better than the user what the user prefers. So the
 * gate is EVIDENCE instead, and {@link checkQuote} is that gate.
 *
 * IDEMPOTENT by the authority's own contract: `FactsStore.upsert` is keyed, and
 * it reports `unchanged` when the value it holds is already this one. A resumed
 * pass therefore ADOPTS the fact it already wrote rather than writing a second
 * copy — there is no second copy a keyed store can make.
 *
 * The quote rides the route, so the changelog line an owner reads carries the
 * sentence the fact was written from.
 */
function routeFact(
  deps: RefinementDeps,
  edit: Extract<RefinementEdit, { kind: 'fact' }>,
  request: RefinementRequest,
  reviewed: readonly TurnOutcomeRow[],
): RefinementRoute {
  const verdict = checkQuote(edit.quote, reviewed);
  if (!verdict.ok) {
    return {
      kind: 'fact', owner: 'agent_facts', target: edit.key,
      disposition: 'refused', reason: verdict.reason,
    };
  }
  const outcome = deps.facts.upsert(edit.key, edit.value, { source: `refinement:${request.id}` });
  return {
    kind: 'fact',
    owner: 'agent_facts',
    target: edit.key,
    disposition: 'applied',
    reason: `${outcome === 'unchanged' ? 'already recorded' : outcome} from the user's own words `
      + `"${edit.quote.trim().replace(/\s+/gu, ' ')}" — ${edit.rationale}`,
  };
}

/**
 * A section candidate reaches the proposal gate, measured.
 *
 * IDEMPOTENT by ADOPTION. `proposePromptSection` allows one pending version per
 * section, so a resumed pass whose first attempt already landed one is refused
 * `already_pending` — and that refusal is not a failure here, it is the record
 * of this request's own earlier write. The pending row is checked for exactly
 * this candidate's source before the proposal is attempted, so the resumed pass
 * adopts its own version number instead of reporting a refusal for work it did.
 */
async function routePromptSection(
  deps: RefinementDeps,
  edit: Extract<RefinementEdit, { kind: 'prompt_section' }>,
): Promise<RefinementRoute> {
  const owner = 'prompt_section_versions';
  const pendingReason = (version: number, note: string): RefinementRoute => ({
    kind: 'prompt_section',
    owner,
    target: `${edit.sectionId}:${String(version)}`,
    disposition: 'pending_trials',
    reason: `${note}; the live prompt does not move until the section lane's calibrated rule `
      + 'promotes it',
  });

  // Adoption first: a pending row already carrying these exact bytes IS this
  // route's own earlier write, recovered.
  const already = getPendingPromptSection(deps.control.sql, edit.sectionId);
  if (already && already.source === edit.source) {
    return pendingReason(already.version, 'pending held-out trials (adopted from an earlier pass)');
  }

  let measured;
  try {
    measured = await proposeMeasuredPromptSection(deps.control, {
      sectionId: edit.sectionId,
      source: edit.source,
      rationale: edit.rationale,
    });
  } catch (err) {
    return {
      kind: 'prompt_section', owner, target: edit.sectionId,
      disposition: 'refused', reason: renderThrownChain({ cause: err }),
    };
  }
  if (!measured.ok) {
    return {
      kind: 'prompt_section', owner, target: edit.sectionId,
      disposition: 'refused', reason: `${measured.code}: ${measured.error}`,
    };
  }
  return pendingReason(
    measured.version,
    `pending held-out trials — candidate ${measured.candidateScore.mean.toFixed(3)} against `
      + `incumbent ${measured.incumbentScore.mean.toFixed(3)}`,
  );
}


// ── Settlement ───────────────────────────────────────────────────────────────

/**
 * Read the owners for a verdict on a request whose routes have all been made.
 *
 * DERIVED, never notified. The section store records whether a version is
 * pending, current or rolled back, and the approval store records the owner's
 * standing decision about exact bytes, so asking them is the only reading that
 * cannot drift — a callback from either promotion path into this module would be
 * a second opinion about a status its owner holds.
 *
 * Returns null while anything is genuinely pending, or when the guarded
 * transition finds the row already moved.
 */
async function settleRoutes(
  deps: RefinementDeps,
  request: RefinementRequest,
): Promise<RefinementRequestView | null> {
  const versions = listPromptSectionVersions(deps.control.sql, 200);
  let promoted = 0;
  let rolledBack = 0;
  let rejected = 0;
  let pending = 0;
  const blocked: string[] = [];
  // Routes that are ALREADY applied on the row: a fact written at routing time,
  // or a skill the owner approved. Counted rather than looked up, because
  // neither has an owner-side pending state left to read — the memory authority
  // has none, and an approved skill's promotion was verified when it happened.
  const alreadyApplied = request.routes.filter((route) => route.disposition === 'applied').length;
  // The owner said no. Counted apart from a gate refusal because they are not
  // the same event (see REFINEMENT_DISPOSITIONS).
  rejected = request.routes.filter((route) => route.disposition === 'rejected').length;

  for (const route of request.routes) {
    if (route.disposition === 'pending_trials' && route.kind === 'prompt_section') {
      const [sectionId, version] = route.target.split(':');
      const row = versions.find((candidate) =>
        candidate.sectionId === sectionId && String(candidate.version) === version);
      if (!row || row.status === 'pending') { pending += 1; continue; }
      if (row.status === 'rolled_back') rolledBack += 1;
      else promoted += 1;
      continue;
    }
    if (route.disposition === 'pending_owner_approval' && route.kind === 'skill') {
      const settled = await settleSkillApproval(deps, request, route);
      if (settled.state === 'pending') {
        pending += 1;
        // A promotion that CANNOT complete is a fault an owner has to see, not a
        // quiet wait. It reads as pending because it is still owed, and the
        // reason says why it has not happened.
        if (settled.reason !== undefined) blocked.push(settled.reason);
      } else if (settled.state === 'rolled_back') rolledBack += 1;
      else promoted += 1;
    }
  }

  const store = createRefinementStore(deps.control.sql);
  if (pending > 0) {
    // Still waiting on an owner. From `gated` that is a real transition — the
    // routes are made and the request is now in someone else's hands.
    const waiting = `${String(pending)} proposal${pending === 1 ? '' : 's'} awaiting their owners`
      + (blocked.length > 0 ? ` · ${blocked.join(' · ')}` : '');
    if (request.stage === 'evaluating') {
      // Already waiting, so there is no transition to make — but a BLOCKED
      // promotion is a fault an owner has to be able to read, and a detail line
      // that still said "awaiting their owners" would hide it behind a wait that
      // is not the owner's fault. Recorded in place; no stage moves.
      if (blocked.length === 0 || request.detail === waiting) return null;
      store.record(request.id, 'evaluating', { detail: waiting });
      return refinementRequestView(store.get(request.id) ?? request);
    }
    if (!store.advance(request.id, 'gated', 'evaluating', { detail: waiting })) return null;
    return refinementRequestView(store.get(request.id) ?? request);
  }
  // "Applied" means at least one artifact IS in effect — a promoted proposal or
  // a fact the user's own words earned. A request that wrote a preference and
  // then lost its section trial has still changed the agent, so calling it
  // rolled_back would be a lie about the fact that is live.
  const landed = promoted + alreadyApplied;
  const undone = rolledBack + rejected;
  const stage: RefinementStage = landed > 0 ? 'applied' : undone > 0 ? 'rolled_back' : 'refused';
  const parts: string[] = [];
  if (promoted > 0) {
    parts.push(`${String(promoted)} proposal${promoted === 1 ? '' : 's'} in effect on their `
      + "owners' own evidence");
  }
  if (alreadyApplied > 0) {
    parts.push(`${String(alreadyApplied)} edit${alreadyApplied === 1 ? '' : 's'} in effect: `
      + "preferences from the user's own words, and skills you approved");
  }
  if (rolledBack > 0) {
    parts.push(`${String(rolledBack)} rolled back — the incumbent won its trials`);
  }
  if (rejected > 0) parts.push(`${String(rejected)} rejected by you`);
  if (parts.length === 0) parts.push('every proposed edit was refused');
  const from: RefinementStage = request.stage === 'gated' ? 'gated' : 'evaluating';
  if (!store.advance(request.id, from, stage, { detail: parts.join('; ') })) return null;
  return refinementRequestView(store.get(request.id) ?? request);
}
