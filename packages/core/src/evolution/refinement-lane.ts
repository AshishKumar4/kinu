// The refinement lane: turns a captured trajectory into typed edits in the
// authorities that already own them.
//
// `requestRefinement` opens the durable row with no model call and no artifact
// write; `advanceRefinementLane` runs one step. The refiner is read-only, so
// `resetStalePlanning` is the whole crash recovery.
//
// The refiner is a temporary agent (`agents.ask`) with no write authority: it
// returns prose, this module parses it, and every write is made here against a
// named owner. Nothing here promotes: sections land pending for held-out trials,
// skills wait for owner approval, subagent specs are refused, and facts must be
// backed by the user's own sentence in the reviewed turns.

import * as v from 'valibot';

import { controlTranscript, proposeMeasuredPromptSection } from './control';
import { buildOutcomeEvalSplit } from './eval-split';
import {
  describeSplitDegeneracy, listTurnOutcomes, type TurnOutcomeRow,
} from './outcomes';
import {
  MIN_EDIT_RATIONALE, REFINEMENT_EDIT_KINDS, REFINEMENT_PROPOSAL_EXAMPLE,
  RefinementProposalSchema, createRefinementStore, evolutionDebt,
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
import { renderIssues } from '../utils/json';
import { renderThrownChain, tolerate, type ErrorCode } from '../obs/index';
import type { TemporaryRunRequest } from '../subordinates/temporary';
import type { SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';

export interface RequestRefinementInput {
  readonly trigger: RefinementTrigger;
  readonly scope: RefinementScope;
  readonly sessionId?: string;
  /** Omitted: the workspace's unresolved negative outcomes. */
  readonly turnIds?: readonly string[];
  readonly debtKey?: string;
}

/** Shared by request-time and claim-time refusal so the owner reads one sentence. */
const ACCOUNT_SCOPE_REFUSAL =
  'account scope is refused: every authority reachable from a workspace database '
  + '(agent_facts, prompt_section_versions, instruction_approvals) is scoped to THIS '
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

  // Keep the caller's (reading) order; the ledger only filters to graded turns.
  const graded = new Set(
    listTurnOutcomes(sql, actor, { turnIds })
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
 * The automatic trigger, or null when nothing is owed. Safe every tick: the
 * debt key is the idempotency key, and a taken batch stops counting as debt.
 */
export async function refinementDebtRequest(
  deps: RefinementDeps,
): Promise<RefinementRequestView | null> {
  const debt = evolutionDebt(deps.control.sql, deps.control.rt.actor);

  if (!debt.owed) return null;

  return requestRefinement(deps, {
    trigger: 'evolution_debt',
    scope: 'workspace',
    turnIds: debt.turnIds,
    debtKey: debt.key,
  });
}

export function refinementDebt(deps: RefinementDeps): EvolutionDebt {
  return evolutionDebt(deps.control.sql, deps.control.rt.actor);
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
export async function advanceRefinementLane(
  deps: RefinementDeps,
): Promise<RefinementLaneStep> {
  const store = createRefinementStore(deps.control.sql, deps.control.rt.actor);
  store.resetStalePlanning();

  // `gated` too: a host killed between routing and settle leaves the row there.
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

    // Null: the claim was lost to recovery and this pass wrote nothing.
    return planned === null ? { step: 'idle' } : { step: 'planned', request: planned };
  } finally {
    // A claim left registered would make recovery skip a row nothing drives.
    claimed.release();
  }
}

/** `applied` or `rejected`. Fact `applied` is included: re-routing a fact is a no-op. */
function ownerHasDecided(route: RefinementRoute): boolean {
  return route.disposition === 'applied' || route.disposition === 'rejected';
}

/** Reading order; `listTurnOutcomes` is newest-first. */
function reviewedTrajectory(
  sql: SqlExecutor, actor: ActorHandle, request: RefinementRequest,
): TurnOutcomeRow[] {
  const byId = new Map(
    listTurnOutcomes(sql, actor, { turnIds: request.turnIds })
      .map((row) => [row.turnId, row] as const),
  );

  return request.turnIds
    .map((id) => byId.get(id))
    .filter((row): row is TurnOutcomeRow => row !== undefined);
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
async function plan(
  deps: RefinementDeps,
  claim: RefinementClaim,
): Promise<RefinementRequestView | null> {
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

  // Persist the plan before any owner write; also the first claim fence.
  if (request.proposal === null
    && !claim.record({ proposal, detail: proposal.summary })) return null;

  const reviewed = reviewedTrajectory(deps.control.sql, deps.control.rt.actor, request);
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
    routes.push(await routeEdit(deps, { edit, request, reviewed }));

    // Persist after each route so a crash between owner writes keeps them recorded.
    if (!claim.record({ routes })) return null;
  }

  if (!claim.advance('gated', { routes, detail: proposal.summary })) return null;

  return await settleRoutes(deps, store.get(request.id) ?? request) ?? view();
}

type RefinerAnswer =
  | { readonly ok: true; readonly proposal: RefinementProposal }
  | { readonly ok: false; readonly error: string };

/** One of the nine error codes, so owner-visible refusals use the shared vocabulary. */
const OFF_SCHEMA_ANSWER: ErrorCode = 'bad_input';

/** Instruction files the refiner may read itself, offered only when present:
 *  the port refuses an absent path by name. `memory/MEMORY.md` is where
 *  genesis (`identity/create.ts`) writes it; `AGENTS.md` is owner-written. */
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

  // Annotated, not inlined: this is the only production site supplying
  // `contextRefs`, and `gate:wired` cannot see a literal passed to a method.
  const brief: TemporaryRunRequest = {
    role: 'task',
    roleLabel: 'refiner',
    task: await renderRefinerBrief(deps, request, contextRefs),
    contextRefs,
    // Plan mode: a refiner that could write would be a second authority.
    mode: 'plan',
  };

  const outcome = await refiner.run(brief);

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
    // `renderIssues` names each issue's path, so the refusal names keys to fix.
    return {
      ok: false,
      error: `the refiner's answer is not a valid refinement proposal (${OFF_SCHEMA_ANSWER}) — `
        + renderIssues(parsed.issues),
    };
  }

  return { ok: true, proposal: parsed.output };
}

/**
 * The refiner's brief: trajectory, addressable artifacts, prior refinements, and the answer shape.
 *
 * Held-out (val) turns from `buildOutcomeEvalSplit` are withheld: section trials score on them, so showing them
 * would let a proposal memorise its exam (GEPA keeps the same split). Turns are bounded by `EVIDENCE_BUDGETS`. The
 * answer shape is printed from `REFINEMENT_PROPOSAL_EXAMPLE`, so brief and schema cannot disagree.
 */
async function renderRefinerBrief(deps: RefinementDeps, request: RefinementRequest, contextRefs: readonly string[]): Promise<string> {
  const sql = deps.control.sql;
  const actor = deps.control.rt.actor;

  const split = await buildOutcomeEvalSplit(
    sql, actor, controlTranscript(deps.control), clampGepaEvalBudget(deps.control.config.getGepaEvalBudget()),
  );

  // `input` (the user message) is the only handle shared with ledger rows.
  const heldOut = new Set(split.val.map((instance) => instance.input));

  const reviewed = reviewedTrajectory(sql, actor, request)
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

  const history = createRefinementStore(sql, actor).list(5)
    .filter((prior) => prior.id !== request.id)
    .map((prior) => `  - ${prior.id} (${prior.trigger}, ${prior.stage}): ${prior.detail || '(no detail)'}`
      + prior.routes.map((r) => `\n      ${r.kind} → ${r.owner || 'no owner'} ${r.target} [${r.disposition}]`).join(''))
    .join('\n');

  // Printed from a schema-valid value at this request's scope, which `plan` enforces.
  const answer: RefinementProposal = { ...REFINEMENT_PROPOSAL_EXAMPLE, scope: request.scope };
  const answerKeys = Object.keys(answer).map((key) => `\`${key}\``).join(', ');

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
    `One JSON object carrying exactly these keys — ${answerKeys} — and no others. Every level is`,
    'strict: a key that is not named here refuses the whole proposal rather than being dropped, so',
    'anything you want to say that is not one of these fields has no place to go. Each edit object',
    `carries exactly the keys its \`kind\` shows below, and every \`rationale\` is `
      + `${String(MIN_EDIT_RATIONALE)} characters or longer, whatever the kind.`,
    '',
    `\`scope\` is ${JSON.stringify(answer.scope)} — the scope this request was opened at. A proposal`,
    'at any other scope is refused without being routed.',
    '',
    `{"scope":${JSON.stringify(answer.scope)},"summary":${JSON.stringify(answer.summary)},"edits":[`,
    ...answer.edits.map((edit, index) =>
      `  ${JSON.stringify(edit)}${index === answer.edits.length - 1 ? '' : ','}`),
    ']}',
    '',
    `Valid \`kind\` values: ${REFINEMENT_EDIT_KINDS.join(', ')}. The four edits above are every shape`,
    'this accepts, one object per edit — not a checklist. Propose the fewest edits that address the',
    'pattern you actually found. An empty `edits` array is a legitimate answer when the trajectory',
    'shows no addressable pattern.',
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

/** Hand one typed edit to its owning authority; the route stores only a pointer
 *  to the identity there, so the two rows cannot disagree. */
async function routeEdit(
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

/** A quote must be a real fragment, not a common token: "keep it short please"
 *  is the floor. */
const MIN_QUOTE_CHARS = 20;

const MIN_QUOTE_WORDS = 4;

/** User words only (message and follow-up): an agent-sourced preference would
 *  be the agent writing its own instructions. */
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

  // Whitespace-normalised and case-insensitive (the ledger re-wraps what it
  // stored); the user's words must still appear in order.
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
 * The one immediate write: no trial can judge a user preference, so
 * {@link checkQuote} is the gate. Idempotent via the keyed `FactsStore.upsert`.
 * The quote rides the route into the changelog.
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
 * Measured section proposal. One pending version per section, so a resumed
 * pass adopts a pending row with identical source instead of reporting
 * `already_pending` for its own earlier write.
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

  // Adoption first: identical pending bytes are this route's own earlier write.
  const already = getPendingPromptSection(deps.control.sql, deps.control.rt.actor, edit.sectionId);

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

/** Applied when any artifact is in effect: a live fact plus a lost section
 *  trial is still a changed agent. */
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
async function settleRoutes(
  deps: RefinementDeps,
  request: RefinementRequest,
): Promise<RefinementRequestView | null> {
  const versions = listPromptSectionVersions(deps.control.sql, deps.control.rt.actor, 200);
  let promoted = 0;
  let rolledBack = 0;
  let rejected = 0;
  let pending = 0;
  const blocked: string[] = [];
  // Facts and approved skills have no owner-side pending state left to read.
  const alreadyApplied = request.routes.filter((route) => route.disposition === 'applied').length;
  // Owner rejections are distinct from gate refusals (see REFINEMENT_DISPOSITIONS).
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

        // A promotion that cannot complete stays pending with its reason shown.
        if (settled.reason !== undefined) blocked.push(settled.reason);
      } else if (settled.state === 'rolled_back') rolledBack += 1;
      else promoted += 1;
    }
  }

  const store = createRefinementStore(deps.control.sql, deps.control.rt.actor);

  if (pending > 0) {
    // From `gated` this is a real transition into the owners' hands.
    const waiting = `${String(pending)} proposal${pending === 1 ? '' : 's'} awaiting their owners`
      + (blocked.length > 0 ? ` · ${blocked.join(' · ')}` : '');

    if (request.stage === 'evaluating') {
      // No transition, but record a blocked promotion's reason in place so it
      // is not hidden behind "awaiting their owners".
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
