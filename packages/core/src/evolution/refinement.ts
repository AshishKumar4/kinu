// Continual refinement: the durable request row, its stage machine, and the debt that opens one.
// The row records where each typed edit was routed; artifacts stay in their owners' stores.
// Every `advance` is `WHERE stage = <from>`, so duplicate delivery is a no-op. Recovery is by
// activation, not clock; the row carries its pass's claim token so a revoked pass stops before
// its next owner write.

import * as v from 'valibot';

import type { RawSqlExec, SqlExecutor } from '../types/primitives';
import type { ActorHandle } from '../identity/actor-handle';
import { sqlCheckList } from '../identity/schema';
import type { FactsStore } from '../memory/facts';
import type { InstructionApprovalStore } from '../safety/instruction-trust';
import type { TemporaryAgentPort } from '../subordinates/temporary';
import type { ScaffoldControl } from './control';
import { JsonValueSchema, parseJsonValue, type JsonValue } from '../utils/json';
import { fnv1a64 } from '../utils/fnv1a';
import { nanoid } from '../utils/nanoid';
import { nowMs } from '../utils/date';
import { diagnostics, toKinuError, tolerate } from '../obs/index';
import { NEGATIVE_TURN_OUTCOMES, listTurnOutcomes } from './outcomes';

export const REFINEMENT_TRIGGERS = ['explicit', 'evolution_debt'] as const;

export type RefinementTrigger = (typeof REFINEMENT_TRIGGERS)[number];

/** `account` scope has no writable authority here, so it is refused by name rather than narrowed. */
export const REFINEMENT_SCOPES = ['workspace', 'account'] as const;

export type RefinementScope = (typeof REFINEMENT_SCOPES)[number];

export const REFINEMENT_STAGES = [
  'requested', 'planning', 'gated', 'evaluating', 'applied', 'rolled_back', 'refused',
] as const;

export type RefinementStage = (typeof REFINEMENT_STAGES)[number];

export const REFINEMENT_EDIT_KINDS = [
  'fact', 'prompt_section', 'skill', 'subagent_spec',
] as const;

export type RefinementEditKind = (typeof REFINEMENT_EDIT_KINDS)[number];

/** Exported so the refiner's brief states the same floor the parse enforces. */
export const MIN_EDIT_RATIONALE = 40;

const RationaleSchema = v.pipe(v.string(), v.minLength(MIN_EDIT_RATIONALE));

const NonEmpty = v.pipe(v.string(), v.nonEmpty());

/** `fact` carries a quote checked against the reviewed trajectory: facts are written with no trial. */
export type RefinementEdit =
  | {
    readonly kind: 'fact';
    readonly key: string;
    readonly value: JsonValue;
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

/** `strictObject` at every level: a permissive parse would drop unknown fields such as `scope` and apply the edit in a way nobody wrote. */
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

/** Long enough to clear the floor, so the printed example parses. */
const RATIONALE_SLOT = '<why this is the smallest edit that would have prevented the failure, in at '
  + `least ${String(MIN_EDIT_RATIONALE)} characters>`;

/** Printed in the refiner's brief; every placeholder is a legal value, so the example parses as-is. */
export const REFINEMENT_PROPOSAL_EXAMPLE: RefinementProposal = {
  scope: 'workspace',
  summary: '<one sentence: the pattern in the turns above that these edits fix>',
  edits: [
    {
      kind: 'fact',
      key: '<dotted.key>',
      value: '<any JSON value>',
      quote: '<the user\'s own words, copied verbatim from a turn above>',
      rationale: RATIONALE_SLOT,
    },
    {
      kind: 'prompt_section',
      sectionId: '<one registered section id from the inventory above>',
      source: '<the whole replacement section, same template slots>',
      rationale: RATIONALE_SLOT,
    },
    {
      kind: 'skill',
      path: '/workspace/skills/<name>.md',
      source: '<the whole file>',
      rationale: RATIONALE_SLOT,
    },
    {
      kind: 'subagent_spec',
      role: '<role id>',
      spec: '<the change to that role\'s spec>',
      rationale: RATIONALE_SLOT,
    },
  ],
};

/**
 * Pending states differ: a fact is live now, a section awaits a trial, a skill awaits the owner.
 * `refused` is a deterministic gate; `rejected` is the owner declining.
 */
export const REFINEMENT_DISPOSITIONS = [
  'applied', 'pending_trials', 'pending_owner_approval', 'refused', 'rejected',
] as const;

export type RefinementDisposition = (typeof REFINEMENT_DISPOSITIONS)[number];

export interface RefinementDeps {
  /** Same control plane as the scaffold and section lanes, so one judge measures everything. */
  readonly control: ScaffoldControl;
  /** The one memory authority: explicit user preferences are written here only. */
  readonly facts: FactsStore;
  /** null: no roster substrate; requests stay `requested` for a host that can run them. */
  readonly refiner?: TemporaryAgentPort | null;
  /** Absent means no owner surface; a skill edit says so. */
  readonly approvals?: InstructionApprovalStore;
}

export interface RefinementRoute {
  readonly kind: RefinementEditKind;
  /** Empty exactly where no writable authority exists. */
  readonly owner: string;
  /** A fact key, `<sectionId>:<version>`, an instruction path, or a role id. */
  readonly target: string;
  readonly disposition: RefinementDisposition;
  /** Skill routes only: instruction trust is per-bytes, and settlement compares this rather than prose in `reason`. */
  readonly digest?: string;
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
  /** Turns stay in `turn_outcomes`; this is a reference only. */
  readonly turnIds: readonly string[];
  /** The automatic trigger's idempotency key; null for an explicit request. */
  readonly debtKey: string | null;
  /** The refiner's answer, exactly as it validated. Null until it answers. */
  readonly proposal: RefinementProposal | null;
  readonly routes: readonly RefinementRoute[];
  readonly detail: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Omits proposal bodies: `showRefinement` is the one gated endpoint for staged files. */
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
 * Staged under `.kinu/`, read by nothing that builds a prompt, so a proposal influences nothing before
 * the owner decides; under SKILLS_DIR it would reach the next turn's prompt. Derived, never stored.
 */
export function refinementStagingPath(requestId: string, skillName: string): string {
  return `${REFINEMENT_STAGED_ROOT}/${requestId}/${skillName}.md`;
}

/** Private: name staged files only via `refinementStagingPath`. */
const REFINEMENT_STAGED_ROOT = '/workspace/.kinu/refinement';

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

export function initRefinementTables(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS refinement_requests (
    actor_id   TEXT NOT NULL,
    id         TEXT NOT NULL,
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
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id, id)
  )`);
  // Automatic-trigger idempotency, scoped per actor so one actor's batch cannot block a sibling's.
  execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_refinement_debt_key
           ON refinement_requests(actor_id, debt_key) WHERE debt_key IS NOT NULL`);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_refinement_stage
           ON refinement_requests(actor_id, stage, created_at)`);
}

export interface OpenRefinementInput {
  readonly trigger: RefinementTrigger;
  readonly scope: RefinementScope;
  readonly turnIds: readonly string[];
  readonly sessionId?: string;
  /** Present only for the automatic trigger — the batch's identity. */
  readonly debtKey?: string;
  readonly now?: number;
}

export interface SettleRefinementPatch {
  readonly proposal?: RefinementProposal;
  readonly routes?: readonly RefinementRoute[];
  readonly detail?: string;
  readonly now?: number;
}

/** Every write is fenced by the claim token; call {@link held} before each owner write, since owners cannot be fenced here. */
export interface RefinementClaim {
  readonly request: RefinementRequest;
  held(): boolean;
  /** False once the claim is gone, and then nothing was written. */
  record(patch: SettleRefinementPatch): boolean;
  /** Leave `planning`, releasing the claim. False once the claim is gone. */
  advance(to: RefinementStage, patch?: SettleRefinementPatch): boolean;
  /** Recovery may re-queue the row from here on. */
  release(): void;
}

export interface RefinementStore {
  /** `created` is true only on the first call; only that may cost a refiner run. */
  open(input: OpenRefinementInput): { readonly request: RefinementRequest; readonly created: boolean };
  get(id: string): RefinementRequest | null;
  list(limit?: number): RefinementRequest[];
  nextRequested(): RefinementRequest | null;
  /** `gated` and `evaluating`: a kill between routing and settlement leaves a row in `gated`. */
  settleable(): RefinementRequest[];
  /** Guarded on `from`; unclaimed rows only (a held row is written through its {@link RefinementClaim}). */
  advance(id: string, from: RefinementStage, to: RefinementStage, patch?: SettleRefinementPatch): boolean;
  /** Progress without a stage change; guarded on `stage` and unclaimed, like `advance`. */
  record(id: string, stage: RefinementStage, patch: SettleRefinementPatch): boolean;
  /** Null when the row is not owed. */
  claim(id: string): RefinementClaim | null;
  /** Re-queues claims whose pass is gone, leaving this process's live passes alone. Safe: the refiner is read-only. */
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

/** A corrupt row is reported and read as empty so it cannot wedge the lane. */
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
 * In memory: liveness is not a database property, and a durable flag would be a lease.
 * Module scope, because stores are created per call site and must see each other's live passes.
 */
const liveClaims = new Set<string>();

/** Row, debt key and claim are per actor, so one actor's pass cannot claim a sibling's refinement. */
export function createRefinementStore(sql: SqlExecutor, actor: ActorHandle): RefinementStore {
  const actorId = actor.actorId;
  const authorize = actor.assertCurrent;

  const one = (id: string): RefinementRequest | null => {
    authorize();

    const rows = sql<Row>`SELECT id, trigger, scope, stage, session_id, turn_ids, debt_key,
             proposal, routes, detail, created_at, updated_at
      FROM refinement_requests WHERE actor_id = ${actorId} AND id = ${id} LIMIT 1`;

    return rows[0] ? toRequest(rows[0]) : null;
  };

  const lease = (id: string): { stage: string; claim: string | null } | undefined => {
    authorize();

    return sql<{ stage: string; claim: string | null }>`
      SELECT stage, claim FROM refinement_requests
      WHERE actor_id = ${actorId} AND id = ${id} LIMIT 1`[0];
  };

  /**
   * The guard is read before the write and repeated in it: `SqlExecutor` has no changes count.
   * `claim IS ${claim}` is SQLite null-safe equality. Any stage move clears the claim.
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
      WHERE actor_id = ${actorId} AND id = ${id}
        AND stage = ${guard.stage} AND claim IS ${guard.claim}`;

    return true;
  };

  return {
    open(input) {
      authorize();

      if (input.debtKey !== undefined) {
        const existing = sql<Row>`SELECT id, trigger, scope, stage, session_id, turn_ids, debt_key,
                 proposal, routes, detail, created_at, updated_at
          FROM refinement_requests
          WHERE actor_id = ${actorId} AND debt_key = ${input.debtKey} LIMIT 1`;

        if (existing[0]) return { request: toRequest(existing[0]), created: false };
      }

      const id = `refine-${nanoid()}`;
      const at = input.now ?? nowMs();
      void sql`INSERT INTO refinement_requests
        (actor_id, id, trigger, scope, stage, session_id, turn_ids, debt_key, proposal, routes, detail,
         created_at, updated_at)
        VALUES (${actorId}, ${id}, ${input.trigger}, ${input.scope}, 'requested', ${input.sessionId ?? null},
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
      authorize();

      return sql<Row>`SELECT id, trigger, scope, stage, session_id, turn_ids, debt_key,
               proposal, routes, detail, created_at, updated_at
        FROM refinement_requests WHERE actor_id = ${actorId}
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`.map(toRequest);
    },

    nextRequested() {
      authorize();

      const rows = sql<Row>`SELECT id, trigger, scope, stage, session_id, turn_ids, debt_key,
               proposal, routes, detail, created_at, updated_at
        FROM refinement_requests WHERE actor_id = ${actorId} AND stage = 'requested'
        ORDER BY created_at ASC, id ASC LIMIT 1`;

      return rows[0] ? toRequest(rows[0]) : null;
    },

    settleable() {
      authorize();

      return sql<Row>`SELECT id, trigger, scope, stage, session_id, turn_ids, debt_key,
               proposal, routes, detail, created_at, updated_at
        FROM refinement_requests
        WHERE actor_id = ${actorId} AND stage IN ('gated', 'evaluating')
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
      // Registered before the row is marked, so local recovery never sees the claim without its liveness.
      liveClaims.add(token);
      void sql`UPDATE refinement_requests SET stage = 'planning', claim = ${token},
          updated_at = ${nowMs()}
        WHERE actor_id = ${actorId} AND id = ${id} AND stage = 'requested'`;
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
      authorize();

      const stale = sql<{ id: string; claim: string | null }>`
        SELECT id, claim FROM refinement_requests
        WHERE actor_id = ${actorId} AND stage = 'planning'`
        .filter((row) => row.claim === null || !liveClaims.has(row.claim));

      if (stale.length === 0) return 0;
      const at = nowMs();

      for (const row of stale) {
        // Guarded on the read token so a successor's claim is never wiped.
        void sql`UPDATE refinement_requests SET stage = 'requested', claim = NULL, updated_at = ${at}
          WHERE actor_id = ${actorId} AND id = ${row.id}
            AND stage = 'planning' AND claim IS ${row.claim}`;
      }

      return stale.length;
    },

    coveredTurnIds() {
      authorize();
      const covered = new Set<string>();

      for (const row of sql<{ id: string; turn_ids: string }>`
        SELECT id, turn_ids FROM refinement_requests WHERE actor_id = ${actorId}`) {
        for (const turnId of decodeColumn<string[]>(TurnIdsSchema, row.turn_ids, [], row.id)) {
          covered.add(turnId);
        }
      }

      return covered;
    },
  };
}

/** `buildOutcomeEvalSplit` holds out round(n/3); three is the smallest batch with a held-out failure. */
const MIN_REFINEMENT_DEBT = 3;

/** Bounds the brief, not the ledger; leftovers accrue to the next batch under its own key. */
const MAX_REFINEMENT_DEBT_BATCH = 12;

export interface EvolutionDebt {
  readonly turnIds: readonly string[];
  readonly owed: boolean;
  /** Idempotency key; empty when nothing is owed. */
  readonly key: string;
  readonly summary: string;
}

/**
 * Derived, never stored. Exclusion happens before the limit, and the cut takes the oldest rows;
 * otherwise refined recent failures hide older unresolved ones forever.
 */
export function evolutionDebt(
  sql: SqlExecutor, actor: ActorHandle, opts: { limit?: number } = {},
): EvolutionDebt {
  const covered = createRefinementStore(sql, actor).coveredTurnIds();
  const seen = new Set<string>();
  const unresolved: string[] = [];

  // `listTurnOutcomes` resolves one effective verdict per turn.
  for (const row of listTurnOutcomes(sql, actor, { limit: -1, outcomes: NEGATIVE_TURN_OUTCOMES })) {
    // A row without a turn id cannot be excluded later, so counting it would make the debt permanent.
    if (row.turnId === null || covered.has(row.turnId) || seen.has(row.turnId)) continue;
    seen.add(row.turnId);
    unresolved.push(row.turnId);
  }

  // Ledger order is newest-first; the oldest unresolved failure is owed.
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
      + (backlog > 0 ? `, and ${String(backlog)} more waiting behind this batch` : ''),
  };
}
