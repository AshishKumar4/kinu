/**
 * Caller Worker for the real `ControlPlaneDO` under workerd: only workerd can show a refused call arriving as a rejection
 * over DO RPC and rows outliving the object (`new_sqlite_classes`). Steps are parsed, so a typo is a 400, not a rejection.
 */
import * as v from 'valibot';
import { projectJsonValue, type JsonValue } from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import { ControlPlaneDO } from '../../src/control-plane/control-plane-do';
import {
  adminControlToken, internalCaller, type ControlCaller, type PresentedCaller,
} from '@kinu.run/core/control-plane';
import { controlPlaneStub, type ControlPlaneEnv } from '../../src/control-plane/stub';

export { ControlPlaneDO };

/** `admin` and `ingest` are the real grades; the rest are shapes an attacker can send, since the caller crosses RPC. */
const CallerKindSchema = v.picklist([
  'admin', 'ingest', 'forged', 'empty', 'absent', 'foreign',
]);

type CallerKind = v.InferOutput<typeof CallerKindSchema>;

/** Right shape, wrong value: matches an HMAC-SHA256 digest so a refusal cannot be credited to a shape check. */
const FORGED_TOKEN = 'f'.repeat(64);

/** Wrong keys entirely. Extending `Partial<ControlCaller>` makes this a legal `PresentedCaller` without a cast,
 *  while the gate's schema refuses it at runtime for carrying no token. */
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
    case 'empty': return {};
    case 'absent': return null;
    case 'foreign': return FOREIGN_CALLER;
  }
}

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

/** `pending` is absent by construction: a settlement cannot write a row back to unfinished. */
const AuditSettlementSchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  outcome: v.picklist(['ok', 'denied', 'failed']),
  detail: v.string(),
  actorDigest: v.optional(v.string()),
  reason: v.optional(v.string()),
  code: v.optional(v.string()),
});

/** Keyed on `method` so the argument schema is the method's; no step reaches a stub with an unchecked payload. */
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

/** Both outcomes are recorded, not thrown: "it resolved" must be able to fail an assertion. */
export type ControlPlaneSettlement =
  | { readonly settled: 'resolved'; readonly value: JsonValue }
  | {
    readonly settled: 'rejected';
    /** Reported, not asserted here: what workerd preserves is the driver's finding. */
    readonly name: string;
    readonly message: string;
    /** A custom `Error` subclass does not survive structured serialization. */
    readonly constructorName: string;
    readonly isError: boolean;
  };

/** `JsonValue`: the value has crossed structured clone and is about to cross HTTP. `void` methods answer `null`. */
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
  // A fresh stub per step, as production callers do; reuse could pass off an earlier step's activation.
  const stub = controlPlaneStub(env);

  try {
    return { settled: 'resolved', value: await callStep(stub, caller, step) };
  } catch (cause) {
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
        // A thrown non-Error is itself a finding the driver pins.
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
