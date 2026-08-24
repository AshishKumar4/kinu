/**
 * A caller Worker for the real `ControlPlaneDO`, under real workerd.
 *
 * WHY A SEPARATE WORKER AT ALL. Every other control-plane test drives the STORE,
 * which is deliberately actor-free and therefore provable against `bun:sqlite`.
 * Two of the class's properties are not reachable that way, because both belong
 * to the boundary rather than to the logic:
 *
 *   1. A refused call must arrive at the caller as a REJECTION. `requireControl`
 *      throwing is a fact about a function; a thrown error surviving Durable
 *      Object RPC as a rejected promise rather than as a resolved value is a fact
 *      about workerd, and only workerd can state it.
 *   2. Rows must outlive the object. `ctx.storage.sql` against a fake is a map
 *      that dies with the test; against a SQLite-backed Durable Object it is a
 *      file that outlives the isolate, and `new_sqlite_classes` in the deploy
 *      manifest is the declaration that makes it one.
 *
 * WHAT THIS FILE IS NOT. It holds no control-plane logic, no capability check and
 * no store. It re-exports the production class unchanged, mints its callers
 * through the production derivation, and addresses the object through the
 * production stub — so a green run is a statement about the product. A fixture
 * that reimplemented any of those would prove only that the fixture works.
 *
 * The step list arrives as request JSON and is PARSED, not asserted: it crosses
 * an HTTP boundary, which is the same reason `capability.ts` parses the caller
 * rather than casting it. Parsing is also what makes a mistyped step a 400 here
 * instead of a `not a function` rejection later — and a rejection is exactly what
 * a refusal assertion accepts, so an unparsed step list could pass this suite
 * while proving nothing.
 */
import * as v from 'valibot';
import { projectJsonValue, type JsonValue } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { ControlPlaneDO } from '../../src/control-plane/control-plane-do';
import {
  adminControlToken, internalCaller, type ControlCaller, type PresentedCaller,
} from '../../src/control-plane/capability';
import { controlPlaneStub, type ControlPlaneEnv } from '../../src/control-plane/stub';

export { ControlPlaneDO };

/* ── The callers ─────────────────────────────────────────────────────────── */

/**
 * The callers the driver can ask for.
 *
 * `admin` and `ingest` are the two real grades, minted by the production
 * derivations. The other four are shapes an attacker actually gets to send: the
 * caller value crosses the RPC boundary, so its sender chooses it, and a gate
 * that has never been handed a wrong one has never been tested.
 */
const CallerKindSchema = v.picklist([
  'admin', 'ingest', 'forged', 'empty', 'absent', 'foreign',
]);
type CallerKind = v.InferOutput<typeof CallerKindSchema>;

/** A token of the right shape and the wrong value — the forgery that matters,
 *  because it is what a caller who has read the source but not the secret can
 *  produce. Its length and alphabet match a real HMAC-SHA256 digest so a refusal
 *  cannot be credited to a shape check upstream of the comparison. */
const FORGED_TOKEN = 'f'.repeat(64);

/**
 * A caller carrying the wrong KEYS entirely — what someone who guessed at the
 * protocol would send.
 *
 * Typed rather than cast, and the declaration is the whole trick: extending
 * `Partial<ControlCaller>` means `controlToken` is DECLARED and absent, so this is
 * a legal `PresentedCaller` to the compiler while the gate's schema refuses it at
 * runtime for carrying no token. Reaching the case with a cast would have been an
 * assertion in a test about refusals; widening the product's parameter to
 * `unknown` so a test could send this would have deleted the contract to test it.
 */
interface ForeignCaller extends Partial<ControlCaller> {
  readonly token: string;
  readonly grade: string;
}

const FOREIGN_CALLER: ForeignCaller = { token: 'admin', grade: 'admin' };

function callerOf(env: ControlPlaneEnv, kind: CallerKind): Promise<PresentedCaller> | PresentedCaller {
  switch (kind) {
    case 'admin': return adminControlToken(env);
    case 'ingest': return internalCaller(env);
    case 'forged': return { controlToken: FORGED_TOKEN };
    // Right type, no token: `Partial<ControlCaller>` is inside the union, so this
    // arm needs no cast and proves the schema rather than the type.
    case 'empty': return {};
    case 'absent': return null;
    case 'foreign': return FOREIGN_CALLER;
  }
}

/* ── The steps ───────────────────────────────────────────────────────────── */

const PageRequestSchema = v.object({
  cursor: v.optional(v.object({ after: v.pipe(v.string(), v.nonEmpty()) })),
  limit: v.optional(v.number()),
});

const UserObservationSchema = v.object({
  userId: v.pipe(v.string(), v.nonEmpty()),
  email: v.string(),
  displayName: v.optional(v.nullable(v.string())),
  at: v.optional(v.number()),
});

const WorkspaceObservationSchema = v.object({
  userId: v.pipe(v.string(), v.nonEmpty()),
  name: v.pipe(v.string(), v.nonEmpty()),
  displayName: v.string(),
  createdAt: v.optional(v.number()),
  at: v.optional(v.number()),
});

const AuditDraftSchema = v.object({
  actorEmail: v.string(),
  actorUserId: v.string(),
  operation: v.string(),
  targetKind: v.string(),
  target: v.string(),
  outcome: v.picklist(['pending', 'ok', 'denied', 'failed']),
  detail: v.string(),
  actorDigest: v.optional(v.string()),
  reason: v.optional(v.string()),
  code: v.optional(v.string()),
});

/** A settlement of a pending attempt. `pending` is absent from the picklist by
 *  construction: a settlement cannot write a row back to unfinished. */
const AuditSettlementSchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  outcome: v.picklist(['ok', 'denied', 'failed']),
  detail: v.string(),
  actorDigest: v.optional(v.string()),
  reason: v.optional(v.string()),
  code: v.optional(v.string()),
});

/** One step: which method, which caller, and the method's own argument. Keyed on
 *  `method` so the argument schema is the method's, which is what stops a step
 *  reaching a stub method with a payload nobody checked. */
const StepSchema = v.variant('method', [
  v.object({ method: v.literal('observeUser'), caller: CallerKindSchema, observation: UserObservationSchema }),
  v.object({ method: v.literal('observeWorkspace'), caller: CallerKindSchema, observation: WorkspaceObservationSchema }),
  v.object({ method: v.literal('recordAudit'), caller: CallerKindSchema, entry: AuditDraftSchema }),
  v.object({ method: v.literal('settleAudit'), caller: CallerKindSchema, settlement: AuditSettlementSchema }),
  v.object({ method: v.literal('listPendingAudit'), caller: CallerKindSchema }),
  v.object({ method: v.literal('overview'), caller: CallerKindSchema }),
  v.object({ method: v.literal('listUsers'), caller: CallerKindSchema, request: v.optional(PageRequestSchema) }),
  v.object({ method: v.literal('listWorkspaces'), caller: CallerKindSchema, request: v.optional(PageRequestSchema) }),
  v.object({ method: v.literal('listAudit'), caller: CallerKindSchema, request: v.optional(PageRequestSchema) }),
]);
type Step = v.InferOutput<typeof StepSchema>;

const StepsSchema = v.array(StepSchema);

/* ── What the driver reads back ──────────────────────────────────────────── */

/**
 * How one step settled.
 *
 * The distinction this whole fixture exists for. `resolved` carries whatever the
 * method returned; `rejected` carries what the platform delivered instead. BOTH
 * are recorded rather than one being thrown, because "it resolved" is exactly the
 * observation that has to be able to FAIL an assertion. A driver that could only
 * report rejections would stay green against a gate that had stopped refusing.
 */
export type ControlPlaneSettlement =
  | { readonly settled: 'resolved'; readonly value: JsonValue }
  | {
    readonly settled: 'rejected';
    /** `error.name` as it arrives. Reported, not asserted on here: what workerd
     *  preserves across the boundary is the driver's finding to pin, not this
     *  file's assumption. */
    readonly name: string;
    readonly message: string;
    /** The runtime constructor the caller receives. A custom `Error` subclass does
     *  not survive structured serialization, and the driver pins what does. */
    readonly constructorName: string;
    /** Whether the caller can still recover an `Error` by `instanceof`. Recorded
     *  so the fixture states the platform's answer instead of implying one. */
    readonly isError: boolean;
  };

/**
 * What a step's method answered, as data.
 *
 * `JsonValue` because the value has already crossed a structured-clone boundary
 * and is about to cross an HTTP one — so JSON is what it demonstrably is, and the
 * driver asserts on it as JSON. `void` methods answer `null`.
 */
async function callStep(
  stub: DurableObjectStub<ControlPlaneDO>, caller: PresentedCaller, step: Step,
): Promise<JsonValue> {
  switch (step.method) {
    case 'observeUser':
      await stub.observeUser(caller, step.observation);
      return null;
    case 'observeWorkspace':
      await stub.observeWorkspace(caller, step.observation);
      return null;
    case 'recordAudit':
      return projectJsonValue({ value: await stub.recordAudit(caller, step.entry) });
    case 'settleAudit':
      return projectJsonValue({ value: await stub.settleAudit(caller, step.settlement) });
    case 'listPendingAudit':
      return projectJsonValue({ value: await stub.listPendingAudit(caller) });
    case 'overview':
      return projectJsonValue({ value: await stub.overview(caller) });
    case 'listUsers':
      return projectJsonValue({ value: await stub.listUsers(caller, step.request) });
    case 'listWorkspaces':
      return projectJsonValue({ value: await stub.listWorkspaces(caller, step.request) });
    case 'listAudit':
      return projectJsonValue({ value: await stub.listAudit(caller, step.request) });
  }
}

async function runStep(env: ControlPlaneEnv, step: Step): Promise<ControlPlaneSettlement> {
  const caller = await callerOf(env, step.caller);
  // A fresh stub per step. Reusing one would let a step pass because an earlier
  // step had already opened the object, and re-addressing per call is what every
  // production caller does anyway.
  const stub = controlPlaneStub(env);
  try {
    return { settled: 'resolved', value: await callStep(stub, caller, step) };
  } catch (cause) {
    // Everything the boundary delivered, projected as data. Nothing is asserted
    // on here: what workerd preserves is the driver's finding to pin. The
    // narrowing happens in the catch, where `unknown` is the LANGUAGE's and not a
    // parameter this fixture chose to leave unparsed.
    return cause instanceof Error
      ? {
        settled: 'rejected',
        name: cause.name,
        message: cause.message,
        constructorName: cause.constructor.name,
        isError: true,
      }
      : {
        settled: 'rejected',
        // A thrown non-Error is itself a finding: the driver pins that workerd
        // delivered something the caller cannot `instanceof`.
        name: 'not-an-error',
        message: renderThrownChain({ cause }),
        constructorName: '',
        isError: false,
      };
  }
}

export default {
  async fetch(request: Request, env: ControlPlaneEnv): Promise<Response> {
    const parsed = v.safeParse(StepsSchema, await request.json());
    if (!parsed.success) {
      return Response.json({ error: v.summarize(parsed.issues) }, { status: 400 });
    }
    const settlements: ControlPlaneSettlement[] = [];
    for (const step of parsed.output) settlements.push(await runStep(env, step));
    return Response.json(settlements);
  },
};
