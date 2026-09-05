// CONTINUAL REFINEMENT — the durable request, its stage machine, and the debt
// that opens one without being asked.
//
// WHAT THIS MODULE OWNS, and it is deliberately narrow: the REQUEST. One row per
// refinement, carrying the trajectory it reviews (by turn id, never by copy),
// the refiner's typed proposal verbatim, and where each typed edit was routed —
// the owner's table name and the identity inside it.
//
// WHAT IT DOES NOT OWN is every artifact a refinement can touch. A fact belongs
// to `agent_facts`, a prompt section to `prompt_section_versions`, a skill's
// trust to `instruction_approvals`, an agent's spec to that agent's own config.
// This row records that a proposal was ROUTED THERE and what came back. A second
// copy of a prompt, a fact, a skill or an agent spec would be a second authority
// for it, and two authorities for one artifact is drift with a schema.
//
// THE STAGE MACHINE, and why each transition is guarded in SQL:
//
//   requested  — the trajectory is captured. Nothing has been asked of a model
//                and no behaviour has moved. This is what a `/refine` returns.
//   planning   — a host has claimed the request and is running the refiner.
//   gated      — the proposal came back and every edit was routed. The gates
//                that could decide immediately have decided.
//   evaluating — at least one edit is pending in an owner's store, waiting for
//                the EXISTING evaluated lane to trial and decide it.
//   applied    — an owner promoted a pending proposal on its own evidence.
//   rolled_back— an owner rolled one back on its own evidence.
//   refused    — nothing was routable, or every route was refused.
//
// Every `advance` is `WHERE stage = <from>`, so an at-least-once delivery, a
// double click, or a resumed drive is a no-op rather than a second application.
// `resetStalePlanning` is the only recovery, and it is by ACTIVATION rather than
// by clock: the refiner is read-only, so re-running a claim that died costs one
// read-only child and can never double-apply. There is no deadline here and
// there must not be one — a clock is not what makes this terminate.
//
// WHICH IS WHY A CLAIM IS FENCED. Activation recovery is only harmless against a
// claim whose pass is GONE, and the reset does not run at the activation
// boundary: the engine that calls it is constructed lazily, so a host can start
// a planner (the `/refine` nudge) and construct its engine afterwards, on the
// next turn — re-queueing a claim whose refiner is still running. The next pass
// then plans the same request from a SECOND refiner answer, and the two passes
// write different bytes into one request's owners: a fact under a key the row
// never records, staged skill bytes the recorded digest no longer describes.
//
// So the row carries the TOKEN of the pass that holds it. Recovery leaves a
// token this process is still executing alone, and a pass whose token was
// revoked — by another process's recovery, the one liveness this process cannot
// see — stops before its next owner write rather than writing behind its
// successor. One column on the request row, no lease and no clock.

import * as v from 'valibot';

import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import { sqlCheckList } from '../identity/schema';
import type { FactsStore } from '../memory/facts';
import type { InstructionApprovalStore } from '../safety/instruction-trust';
import type { TemporaryAgentPort } from '../subordinates/temporary';
import type { ScaffoldControl } from './control';
import { JsonValueSchema, parseJsonValue, type JsonValue } from '../utils/json';
import { fnv1a64 } from '../prompting/volatile-context';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { diagnostics, toKinuError, tolerate } from '../obs/index';
import { NEGATIVE_TURN_OUTCOMES, listTurnOutcomes } from './outcomes';

/** Why a refinement request exists. */
export const REFINEMENT_TRIGGERS = ['explicit', 'evolution_debt'] as const;
export type RefinementTrigger = (typeof REFINEMENT_TRIGGERS)[number];

/**
 * How far a refinement's edits are allowed to reach.
 *
 * `workspace` is this database: the facts, sections and approvals of the one
 * workspace the request was opened in. `account` is every workspace its owner
 * has, and NO authority reachable from here can write it — so an account-scoped
 * proposal is refused by name rather than silently narrowed to this workspace.
 * Stating the scope is the point: a preference the owner meant globally must not
 * quietly become a local one.
 */
export const REFINEMENT_SCOPES = ['workspace', 'account'] as const;
export type RefinementScope = (typeof REFINEMENT_SCOPES)[number];

export const REFINEMENT_STAGES = [
  'requested', 'planning', 'gated', 'evaluating', 'applied', 'rolled_back', 'refused',
] as const;
export type RefinementStage = (typeof REFINEMENT_STAGES)[number];

/** The artifact owners a refinement may address, one per authority. */
export const REFINEMENT_EDIT_KINDS = [
  'fact', 'prompt_section', 'skill', 'subagent_spec',
] as const;
export type RefinementEditKind = (typeof REFINEMENT_EDIT_KINDS)[number];

/** Same bar as a scaffold or section proposal: the operator reads one
 *  changelog, so every edit states why it exists at that length. */
const MIN_EDIT_RATIONALE = 40;

const RationaleSchema = v.pipe(v.string(), v.minLength(MIN_EDIT_RATIONALE));
const NonEmpty = v.pipe(v.string(), v.nonEmpty());

/**
 * One typed edit, discriminated by the authority that owns it.
 *
 * `fact` carries a QUOTE and not just a rationale. A preference reaches the
 * memory authority immediately, with no trial between the proposal and the
 * write, so the only thing that can stand in for a trial is the user's own
 * words — and the router checks the quote against the reviewed trajectory rather
 * than trusting the refiner's claim that it was said.
 */
export type RefinementEdit =
  | {
    readonly kind: 'fact';
    readonly key: string;
    readonly value: JsonValue;
    /** The user's own words, verbatim from a reviewed turn. */
    readonly quote: string;
    readonly rationale: string;
  }
  | {
    readonly kind: 'prompt_section';
    readonly sectionId: string;
    readonly source: string;
    readonly rationale: string;
  }
  | {
    readonly kind: 'skill';
    readonly path: string;
    readonly source: string;
    readonly rationale: string;
  }
  | {
    readonly kind: 'subagent_spec';
    readonly role: string;
    readonly spec: string;
    readonly rationale: string;
  };

export interface RefinementProposal {
  readonly scope: RefinementScope;
  readonly summary: string;
  readonly edits: readonly RefinementEdit[];
}

/**
 * The strict shape the refiner must answer in.
 *
 * `agents.ask` resolves with prose, so this schema is the whole boundary between
 * a model's opinion and a typed edit. A variant rather than a loose object: an
 * edit whose `kind` names no authority has nowhere to go, and an edit missing
 * the field its authority keys on cannot be routed, so both are refused at the
 * parse rather than discovered halfway through routing.
 *
 * `strictObject` at EVERY level, and that is the load-bearing half. A permissive
 * object silently drops what it does not know, so a refiner that answered
 * `{kind:'fact', key, value, quote, rationale, scope:'account'}` would have its
 * scope claim erased and the edit applied at workspace scope — the proposal
 * would be obeyed in a way nobody wrote. An unknown field is a proposal this
 * version cannot honour faithfully, so it is refused whole.
 */
export const RefinementProposalSchema: v.GenericSchema<unknown, RefinementProposal> = v.strictObject({
  scope: v.picklist(REFINEMENT_SCOPES),
  summary: NonEmpty,
  edits: v.array(v.variant('kind', [
    v.strictObject({
      kind: v.literal('fact'),
      key: NonEmpty,
      value: JsonValueSchema,
      quote: NonEmpty,
      rationale: RationaleSchema,
    }),
    v.strictObject({
      kind: v.literal('prompt_section'),
      sectionId: NonEmpty,
      source: NonEmpty,
      rationale: RationaleSchema,
    }),
    v.strictObject({
      kind: v.literal('skill'),
      path: NonEmpty,
      source: NonEmpty,
      rationale: RationaleSchema,
    }),
    v.strictObject({
      kind: v.literal('subagent_spec'),
      role: NonEmpty,
      spec: NonEmpty,
      rationale: RationaleSchema,
    }),
  ])),
});

/**
 * What became of one typed edit.
 *
 * The three that are neither `refused` nor `rejected` are three different KINDS
 * of "not yet live": a fact is live now, a section is pending a trial the
 * existing lane will run, a skill is pending a decision only the owner can make.
 * Folding them into one "accepted" would hide which of those a changelog line is
 * about.
 *
 * `refused` and `rejected` are also not the same thing, and the difference is
 * WHO said no. A refusal is a deterministic gate working as designed — a quote
 * that is not the user's, a section the size rule priced out. A rejection is the
 * OWNER declining bytes they were shown. An owner reading "refused" about their
 * own decision learns nothing about it, and a rate that mixed the two would
 * measure the gates and the person as one signal.
 */
export const REFINEMENT_DISPOSITIONS = [
  'applied', 'pending_trials', 'pending_owner_approval', 'refused', 'rejected',
] as const;
export type RefinementDisposition = (typeof REFINEMENT_DISPOSITIONS)[number];

/** What the lane needs from whichever host is driving it. */
export interface RefinementDeps {
  /** The evolution control plane — the same seam the scaffold and section lanes
   *  run on, so a refinement is measured by exactly the judge that measures
   *  everything else about this agent. */
  readonly control: ScaffoldControl;
  /** The ONE memory authority. An explicit user preference is written here and
   *  nowhere else. */
  readonly facts: FactsStore;
  /**
   * The read-only recursive refiner — the temporary-agent port.
   *
   * Absent means this host has no roster substrate, so it cannot run a refiner.
   * A request then STAYS `requested` for a host that can, rather than being
   * refused for a reason that is about the host and not about the request.
   */
  readonly refiner?: TemporaryAgentPort;
  /** The owner's instruction-trust authority — where a proposed skill's digest
   *  is reported so the owner can approve those exact bytes. Absent means this
   *  host has no owner surface and a skill edit says so. */
  readonly approvals?: InstructionApprovalStore;
}

/** Where one edit went, named by the owner's own table and key. */
export interface RefinementRoute {
  readonly kind: RefinementEditKind;
  /** The owner's table. Empty exactly where no writable authority exists, which
   *  is the honest value: naming one would invent it. */
  readonly owner: string;
  /** The identity inside that owner — a fact key, `<sectionId>:<version>`, an
   *  instruction path, a role id. */
  readonly target: string;
  readonly disposition: RefinementDisposition;
  /**
   * The content address the owner's decision is ABOUT, where the authority is
   * content-addressed rather than keyed.
   *
   * Only a skill route carries one, because only instruction trust is settled
   * per-bytes (`safety/instruction-trust.ts`). Held as its own field rather than
   * read back out of `reason`: settlement compares it against the owner's stored
   * decision, and a comparison that had to parse prose would break the first
   * time somebody reworded a sentence.
   */
  readonly digest?: string;
  /** Why, whenever the disposition alone does not say it. */
  readonly reason?: string;
}

const RefinementRouteSchema = v.object({
  kind: v.picklist(REFINEMENT_EDIT_KINDS),
  owner: v.string(),
  target: v.string(),
  disposition: v.picklist(REFINEMENT_DISPOSITIONS),
  digest: v.optional(v.string()),
  reason: v.optional(v.string()),
});

export interface RefinementRequest {
  readonly id: string;
  readonly trigger: RefinementTrigger;
  readonly scope: RefinementScope;
  readonly stage: RefinementStage;
  readonly sessionId: string | null;
  /** The trajectory under review, by turn id. The turns themselves stay in
   *  `turn_outcomes` — this is a reference, so a refinement can never disagree
   *  with the ledger about what happened. */
  readonly turnIds: readonly string[];
  /** The automatic trigger's idempotency key; null for an explicit request. */
  readonly debtKey: string | null;
  /** The refiner's answer, exactly as it validated. Null until it answers. */
  readonly proposal: RefinementProposal | null;
  readonly routes: readonly RefinementRoute[];
  /** One honest sentence about the stage — a refusal's reason, or the
   *  proposal's summary once there is one. */
  readonly detail: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A request as every surface reads it: the row minus the verbatim proposal
 * bodies, which are a whole prompt section or skill file and belong to the
 * changelog's diff view rather than to a listing.
 *
 * ONE projection, exported, because three call sites were spelling it out field
 * by field — the CLI session, the cloud callable, and the lane — and a fourth
 * field added to the row would have reached whichever of them somebody
 * remembered.
 *
 * It carries no proposal BODIES. `showRefinement` is the one endpoint that hands
 * out a staged file, so a listing that also carried the bytes would be a second
 * way to read them — and the one nothing gates, since a listing goes everywhere
 * a view goes.
 */
export interface RefinementRequestView {
  readonly id: string;
  readonly trigger: RefinementTrigger;
  readonly scope: RefinementScope;
  readonly stage: RefinementStage;
  readonly turnIds: readonly string[];
  readonly routes: readonly RefinementRoute[];
  readonly detail: string;
  readonly createdAt: number;
}

/**
 * Where a proposed skill's bytes WAIT.
 *
 * Under `.kinu/`, which is the workspace's internal spill root
 * (`SPILL_DIRS`, `EVENT_CONTENT_DIR`) and is read by nothing that builds a
 * prompt. That placement is the whole point: `discoverSkills` walks SKILLS_DIR
 * and `gatherApprovableInstructions` walks the AGENTS.md chain plus SKILLS_DIR,
 * so bytes staged here reach neither the skills index nor the unverified
 * reference tier. A proposal must influence NOTHING before the owner decides,
 * and a file under SKILLS_DIR influences the very next turn's prompt — its front
 * matter enters the index and its body renders as reference material — even
 * though it carries no tool policy.
 *
 * Keyed by request and skill name so two requests proposing the same skill stage
 * separately, and so a staged file is always traceable to the row that owes it.
 * DERIVED, never stored: the request id and the route's target are already on the
 * row, so a stored path would be a third copy of the same fact.
 */
export function refinementStagingPath(requestId: string, skillName: string): string {
  return `${REFINEMENT_STAGING_DIR}/${requestId}/${skillName}.md`;
}

/** The staging root. Private: `refinementStagingPath` is the only way anything
 *  should name a staged file, so a caller cannot assemble half a path. */
const REFINEMENT_STAGING_DIR = '/workspace/.kinu/refinement';

export function refinementRequestView(request: RefinementRequest): RefinementRequestView {
  return {
    id: request.id,
    trigger: request.trigger,
    scope: request.scope,
    stage: request.stage,
    turnIds: request.turnIds,
    routes: request.routes,
    detail: request.detail,
    createdAt: request.createdAt,
  };
}

export function initRefinementTables(execRaw: RawSqlExec, sql: SqlExecutor): void {
  execRaw(`CREATE TABLE IF NOT EXISTS refinement_requests (
    id         TEXT PRIMARY KEY,
    trigger    TEXT NOT NULL CHECK (trigger IN (${sqlCheckList(REFINEMENT_TRIGGERS)})),
    scope      TEXT NOT NULL CHECK (scope IN (${sqlCheckList(REFINEMENT_SCOPES)})),
    stage      TEXT NOT NULL CHECK (stage IN (${sqlCheckList(REFINEMENT_STAGES)})),
    -- The pass holding this row, non-null exactly while it is planning. A lease
    -- identity, never a deadline: it says WHO is planning, and nothing at all
    -- about for how long.
    claim      TEXT,
    session_id TEXT,
    turn_ids   TEXT NOT NULL,
    debt_key   TEXT,
    proposal   TEXT,
    routes     TEXT NOT NULL,
    detail     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // The automatic trigger's whole idempotency: one batch of unresolved
  // failures is one request, so a restart that re-derives the same batch
  // collides here instead of opening a second refinement over the same turns.
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_refinement_debt_key
           ON refinement_requests(debt_key) WHERE debt_key IS NOT NULL`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_refinement_stage
           ON refinement_requests(stage, created_at)`);
  void sql`SELECT 1 FROM refinement_requests LIMIT 0`;
}

/** How a request is opened. */
export interface OpenRefinementInput {
  readonly trigger: RefinementTrigger;
  readonly scope: RefinementScope;
  readonly turnIds: readonly string[];
  readonly sessionId?: string;
  /** Present only for the automatic trigger — the batch's identity. */
  readonly debtKey?: string;
  readonly now?: number;
}

/** What one edit's routing left on the row. */
export interface SettleRefinementPatch {
  readonly proposal?: RefinementProposal;
  readonly routes?: readonly RefinementRoute[];
  readonly detail?: string;
  readonly now?: number;
}

/**
 * One pass's hold on one request while it plans.
 *
 * The whole reason the planner takes a handle rather than an id: every write it
 * makes is fenced by the token behind this object, so a pass that lost the row
 * cannot write to it, and a pass cannot forget to check. {@link held} is the
 * read the planner takes BEFORE each owner write — the owners are other stores
 * and cannot be fenced from here, so the last moment this row can stop a revoked
 * pass is before it writes to one.
 */
export interface RefinementClaim {
  /** The row as it was claimed. */
  readonly request: RefinementRequest;
  /** Whether this pass still holds the row. */
  held(): boolean;
  /** Persist the plan or its progress, still `planning`. False once the claim
   *  is gone — and then nothing was written. */
  record(patch: SettleRefinementPatch): boolean;
  /** Leave `planning`, releasing the claim. False once the claim is gone. */
  advance(to: RefinementStage, patch?: SettleRefinementPatch): boolean;
  /** This pass is no longer executing. Recovery may re-queue the row from here
   *  on, which is what makes a pass that threw recoverable without a clock. */
  release(): void;
}

export interface RefinementStore {
  /**
   * Open a request, or answer with the one that already covers this batch.
   *
   * `created` is the load-bearing half: the automatic trigger calls this every
   * time it derives debt, and only the first call may cost a refiner run.
   */
  open(input: OpenRefinementInput): { readonly request: RefinementRequest; readonly created: boolean };
  get(id: string): RefinementRequest | null;
  /** Requests newest first — what the changelog and the surfaces read. */
  list(limit?: number): RefinementRequest[];
  /** The oldest request owed a refiner run, or null. */
  nextRequested(): RefinementRequest | null;
  /**
   * Every request whose routes are made and whose verdict is not in yet, oldest
   * first — `gated` AND `evaluating`.
   *
   * BOTH, because `gated` is where a hard kill lands. `plan` routes the edits,
   * advances to `gated`, and settles in the same pass; a process killed between
   * those two steps leaves a row with every owner write done and nothing
   * watching it. A scan that only read `evaluating` never returned for it.
   */
  settleable(): RefinementRequest[];
  /**
   * Move one request forward. Guarded on `from`, so this returns false — and
   * writes nothing — for a duplicate delivery or a stage that already moved.
   *
   * For an UNCLAIMED row only: a row a pass holds is written through that pass's
   * {@link RefinementClaim}, so a caller without the token cannot move it.
   */
  advance(id: string, from: RefinementStage, to: RefinementStage, patch?: SettleRefinementPatch): boolean;
  /**
   * Persist progress WITHOUT changing the stage — an owner's decision landing on
   * a `gated` or `evaluating` row.
   *
   * Guarded on `stage` for the same reason `advance` is, and unclaimed for the
   * same reason: two writers must not both be writing one request's routes.
   */
  record(id: string, stage: RefinementStage, patch: SettleRefinementPatch): boolean;
  /**
   * Take `requested` → `planning` for THIS pass, or null when the row is not
   * owed (another pass already claimed it, or an owner already settled it).
   *
   * The claim is what every later write of the pass goes through, so a revoked
   * pass cannot write behind the one that replaced it.
   */
  claim(id: string): RefinementClaim | null;
  /**
   * Re-queue every `planning` claim whose pass is gone. Returns how many rows
   * were re-queued; the refiner is read-only, so re-running is safe.
   *
   * A claim THIS process is still executing is left alone. It is not stale — it
   * is running — and re-queueing it would put a second refiner behind a live one
   * over the same request, with two answers writing into one request's owners.
   */
  resetStalePlanning(): number;
  /** Every turn id any request has taken — the debt derivation's exclusion. */
  coveredTurnIds(): Set<string>;
}

interface Row {
  id: string;
  trigger: string;
  scope: string;
  stage: string;
  session_id: string | null;
  turn_ids: string;
  debt_key: string | null;
  proposal: string | null;
  routes: string;
  detail: string;
  created_at: number;
  updated_at: number;
}

const TurnIdsSchema = v.array(v.string());
const RoutesSchema = v.array(RefinementRouteSchema);

/** Decode one JSON column, or the empty value when the bytes will not parse.
 *  These are this module's own writes, so an undecodable one is a corrupt row —
 *  reported, and read as empty rather than propagated, because one bad row must
 *  not wedge the lane behind it. */
function decodeColumn<T>(schema: v.GenericSchema<unknown, T>, raw: string, empty: T, id: string): T {
  const parsed = v.safeParse(schema, tolerate(() => parseJsonValue(raw), 'malformed-input'));
  if (parsed.success) return parsed.output;
  diagnostics.failure(
    'evolution.refinement_row_unreadable',
    toKinuError({
      doing: 'decode a refinement request row',
      cause: parsed.issues.map((issue) => issue.message).join('; '),
      otherwise: 'bad_input',
    }),
    { id },
  );
  return empty;
}

function toRequest(row: Row): RefinementRequest {
  const proposal = row.proposal === null
    ? null
    : decodeColumn(RefinementProposalSchema, row.proposal, null, row.id);
  return {
    id: row.id,
    trigger: v.parse(v.picklist(REFINEMENT_TRIGGERS), row.trigger),
    scope: v.parse(v.picklist(REFINEMENT_SCOPES), row.scope),
    stage: v.parse(v.picklist(REFINEMENT_STAGES), row.stage),
    sessionId: row.session_id,
    turnIds: decodeColumn<string[]>(TurnIdsSchema, row.turn_ids, [], row.id),
    debtKey: row.debt_key,
    proposal,
    routes: decodeColumn<RefinementRoute[]>(RoutesSchema, row.routes, [], row.id),
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The claims THIS process is still executing.
 *
 * In memory because memory is the only place the fact lives: whether a pass is
 * still running is not a property of the database, and a durable "still alive"
 * flag would be a lease — the deadline this lane refuses to have. A fresh
 * process starts empty, which is exactly right: nothing it can see is running,
 * so every claim it finds is owed again.
 *
 * Module scope, because a store is created per call site rather than held: two
 * `createRefinementStore` calls in one process are two views of one row, and a
 * per-store set would make each of them blind to the other's live passes.
 */
const liveClaims = new Set<string>();

export function createRefinementStore(sql: SqlExecutor): RefinementStore {
  const one = (id: string): RefinementRequest | null => {
    const rows = sql<Row>`SELECT id, trigger, scope, stage, session_id, turn_ids, debt_key,
             proposal, routes, detail, created_at, updated_at
      FROM refinement_requests WHERE id = ${id} LIMIT 1`;
    return rows[0] ? toRequest(rows[0]) : null;
  };

  /** The stage the row is in and the pass holding it, or undefined for no row. */
  const lease = (id: string): { stage: string; claim: string | null } | undefined =>
    sql<{ stage: string; claim: string | null }>`
      SELECT stage, claim FROM refinement_requests WHERE id = ${id} LIMIT 1`[0];

  /**
   * The one UPDATE every writer here makes, under the guard the caller holds.
   *
   * The guard is read BEFORE the write and repeated IN it. `SqlExecutor` is a
   * row reader with no changes count, and comparing the stage afterwards cannot
   * tell "this call moved it" from "it was already there" — which is exactly the
   * duplicate delivery this guard exists to make a no-op.
   *
   * `claim IS ${claim}` is SQLite's null-safe equality: a writer holding no
   * token matches only an unclaimed row, and a pass matches only its own claim.
   * `to` of null is a progress write that leaves the stage and the claim alone;
   * any stage move ends the pass, so it clears the claim with it.
   */
  const write = (
    id: string,
    guard: { stage: RefinementStage; claim: string | null },
    to: RefinementStage | null,
    patch: SettleRefinementPatch,
  ): boolean => {
    const current = lease(id);
    if (current?.stage !== guard.stage || current.claim !== guard.claim) return false;
    const proposal = patch.proposal === undefined ? null : JSON.stringify(patch.proposal);
    const routes = patch.routes === undefined ? null : JSON.stringify([...patch.routes]);
    void sql`UPDATE refinement_requests SET
        stage = COALESCE(${to}, stage),
        claim = CASE WHEN ${to} IS NULL THEN claim ELSE NULL END,
        proposal = COALESCE(${proposal}, proposal),
        routes = COALESCE(${routes}, routes),
        detail = COALESCE(${patch.detail ?? null}, detail),
        updated_at = ${patch.now ?? nowMs()}
      WHERE id = ${id} AND stage = ${guard.stage} AND claim IS ${guard.claim}`;
    return true;
  };

  return {
    open(input) {
      if (input.debtKey !== undefined) {
        const existing = sql<Row>`SELECT id, trigger, scope, stage, session_id, turn_ids, debt_key,
                 proposal, routes, detail, created_at, updated_at
          FROM refinement_requests WHERE debt_key = ${input.debtKey} LIMIT 1`;
        if (existing[0]) return { request: toRequest(existing[0]), created: false };
      }
      const id = `refine-${nanoid()}`;
      const at = input.now ?? nowMs();
      void sql`INSERT INTO refinement_requests
        (id, trigger, scope, stage, session_id, turn_ids, debt_key, proposal, routes, detail,
         created_at, updated_at)
        VALUES (${id}, ${input.trigger}, ${input.scope}, 'requested', ${input.sessionId ?? null},
                ${JSON.stringify([...input.turnIds])}, ${input.debtKey ?? null}, ${null}, '[]', '',
                ${at}, ${at})`;
      const opened = one(id);
      if (!opened) {
        throw toKinuError({
          doing: 'open a refinement request',
          cause: `the row inserted as ${id} did not read back`,
          otherwise: 'io',
        });
      }
      return { request: opened, created: true };
    },

    get: one,

    list(limit = 50) {
      return sql<Row>`SELECT id, trigger, scope, stage, session_id, turn_ids, debt_key,
               proposal, routes, detail, created_at, updated_at
        FROM refinement_requests ORDER BY created_at DESC, id DESC LIMIT ${limit}`.map(toRequest);
    },

    nextRequested() {
      const rows = sql<Row>`SELECT id, trigger, scope, stage, session_id, turn_ids, debt_key,
               proposal, routes, detail, created_at, updated_at
        FROM refinement_requests WHERE stage = 'requested'
        ORDER BY created_at ASC, id ASC LIMIT 1`;
      return rows[0] ? toRequest(rows[0]) : null;
    },

    settleable() {
      return sql<Row>`SELECT id, trigger, scope, stage, session_id, turn_ids, debt_key,
               proposal, routes, detail, created_at, updated_at
        FROM refinement_requests WHERE stage IN ('gated', 'evaluating')
        ORDER BY created_at ASC, id ASC`.map(toRequest);
    },

    advance(id, from, to, patch = {}) {
      return write(id, { stage: from, claim: null }, to, patch);
    },

    record(id, stage, patch) {
      return write(id, { stage, claim: null }, null, patch);
    },

    claim(id) {
      if (lease(id)?.stage !== 'requested') return null;
      const token = nanoid();
      // Registered before the row is marked: a recovery pass in this process
      // must never see the claim without also seeing that it is live.
      liveClaims.add(token);
      void sql`UPDATE refinement_requests SET stage = 'planning', claim = ${token},
          updated_at = ${nowMs()}
        WHERE id = ${id} AND stage = 'requested'`;
      const claimed = one(id);
      if (!claimed) {
        liveClaims.delete(token);
        return null;
      }
      const guard = { stage: 'planning' as const, claim: token };
      return {
        request: claimed,
        held() {
          const current = lease(id);
          return current?.stage === 'planning' && current.claim === token;
        },
        record: (patch) => write(id, guard, null, patch),
        advance(to, patch = {}) {
          const moved = write(id, guard, to, patch);
          if (moved) liveClaims.delete(token);
          return moved;
        },
        release: () => { liveClaims.delete(token); },
      };
    },

    resetStalePlanning() {
      const stale = sql<{ id: string; claim: string | null }>`
        SELECT id, claim FROM refinement_requests WHERE stage = 'planning'`
        .filter((row) => row.claim === null || !liveClaims.has(row.claim));
      if (stale.length === 0) return 0;
      const at = nowMs();
      for (const row of stale) {
        // On the token it read, not merely on the stage: a re-queue that cleared
        // whatever claim it found could wipe a SUCCESSOR's token instead of the
        // dead one it decided about.
        void sql`UPDATE refinement_requests SET stage = 'requested', claim = NULL, updated_at = ${at}
          WHERE id = ${row.id} AND stage = 'planning' AND claim IS ${row.claim}`;
      }
      return stale.length;
    },

    coveredTurnIds() {
      const covered = new Set<string>();
      for (const row of sql<{ id: string; turn_ids: string }>`
        SELECT id, turn_ids FROM refinement_requests`) {
        for (const turnId of decodeColumn<string[]>(TurnIdsSchema, row.turn_ids, [], row.id)) {
          covered.add(turnId);
        }
      }
      return covered;
    },
  };
}

/**
 * Failures a refinement is owed before one is worth opening.
 *
 * Three, and the number is the eval split's own floor rather than a taste
 * judgment. `buildOutcomeEvalSplit` holds out `round(n/3)` of the failures it
 * draws: at three it holds one out and leaves two to reflect on, which is the
 * smallest batch where a proposal is SELECTED on a failure it never saw. Below
 * that the refiner would be generalising from a single turn, and the section
 * gate would refuse the result anyway for want of a held-out negative.
 */
const MIN_REFINEMENT_DEBT = 3;

/**
 * How many failures one derivation will draw.
 *
 * Bounds the brief rather than the ledger: an abandoned workspace can hold
 * hundreds of ungraded corrections, and handing all of them to one refiner
 * would spend a whole context on the oldest half of a history nobody is going
 * to act on. What is left over accrues to the NEXT batch under its own key.
 */
const MAX_REFINEMENT_DEBT_BATCH = 12;

/** The unresolved negative outcomes, and whether they have reached the bar. */
export interface EvolutionDebt {
  /** The turns owed a refinement, oldest first. */
  readonly turnIds: readonly string[];
  /** Whether the batch is large enough to support an out-of-sample selection. */
  readonly owed: boolean;
  /** This batch's identity — the automatic trigger's idempotency key. Empty
   *  when there is nothing owed to key. */
  readonly key: string;
  /** One sentence for the surfaces: what is accumulating, and what it needs. */
  readonly summary: string;
}

/**
 * The automatic trigger's input: corrected/frustrated turns no refinement
 * request has taken yet.
 *
 * DERIVED, never stored. The negatives live in `turn_outcomes` and what has been
 * taken lives on the request rows, so a stored counter could only be a third
 * opinion about a question two tables already answer — and the one that drifts.
 *
 * THE EXCLUSION HAPPENS BEFORE THE LIMIT, and that ordering is the whole
 * correctness of this function. Reading the newest twelve rows and THEN dropping
 * the covered ones — which is what this did — makes a workspace stop accruing
 * debt the moment twelve consecutive failures have been refined: the older
 * unresolved rows sit behind a window that never reaches them again, and the
 * automatic trigger goes permanently quiet with real corrections outstanding.
 * So the negatives are read UNBOUNDED (the same read `hasNegativeOutcome`
 * makes), the covered ones are removed, and only then is the batch cut.
 *
 * The cut takes the OLDEST unresolved rows, because those are the ones that have
 * been waiting, and a newest-first cut would starve them forever for the same
 * reason the windowed read did.
 */
export function evolutionDebt(sql: SqlExecutor, opts: { limit?: number } = {}): EvolutionDebt {
  const covered = createRefinementStore(sql).coveredTurnIds();
  const seen = new Set<string>();
  const unresolved: string[] = [];
  // Unbounded, then filtered: see the note above. `listTurnOutcomes` resolves
  // one effective verdict per turn, so an old classifier `corrected` a later
  // thumb overruled is already gone from this set.
  for (const row of listTurnOutcomes(sql, { limit: -1, outcomes: NEGATIVE_TURN_OUTCOMES })) {
    // A row with no turn id cannot be excluded from a later batch, so counting
    // it would make the debt permanent.
    if (row.turnId === null || covered.has(row.turnId) || seen.has(row.turnId)) continue;
    seen.add(row.turnId);
    unresolved.push(row.turnId);
  }
  // Ledger order is newest-first; a trajectory is read forwards and the oldest
  // unresolved failure is the one owed.
  unresolved.reverse();
  const cap = Math.max(1, opts.limit ?? MAX_REFINEMENT_DEBT_BATCH);
  const batch = unresolved.slice(0, cap);
  const owed = batch.length >= MIN_REFINEMENT_DEBT;
  const backlog = unresolved.length - batch.length;
  return {
    turnIds: batch,
    owed,
    key: batch.length === 0 ? '' : fnv1a64(batch.join('\n')),
    summary: batch.length === 0
      ? 'no unresolved corrections — nothing is owed a refinement'
      : (owed
        ? `${String(batch.length)} unresolved correction${batch.length === 1 ? '' : 's'} `
          + 'are owed a refinement'
        : `${String(batch.length)} unresolved correction${batch.length === 1 ? '' : 's'} — `
          + `a refinement opens at ${String(MIN_REFINEMENT_DEBT)}`)
      // Named rather than dropped: a backlog nobody can see is how the windowed
      // read above stayed wrong.
      + (backlog > 0 ? `, and ${String(backlog)} more waiting behind this batch` : ''),
  };
}
