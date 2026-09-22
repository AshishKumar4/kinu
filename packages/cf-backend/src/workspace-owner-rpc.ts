/**
 * The object that owns one workspace, as the methods a caller in this Worker
 * needs of it.
 *
 * Hosted actors share the root's isolate and its composed workspace box, so
 * their file and execution operations need no owner RPC. This module declares
 * genuinely cross-workspace owner calls, including slate bindings held by a
 * process in another workspace.
 */

import * as v from 'valibot';
import {
  BlueprintBundleSchema, BlueprintForkSchema, BlueprintViewSchema, decodeJsonWire, JsonValueSchema,
  LiveShareRecordSchema, SlateShareRecordSchema,
} from '@kinu.run/core';
import { ERROR_CODES } from '@kinu.run/core/obs';
import type {
  BlueprintBundle, BlueprintFork, LiveShareRecord, ShareViewerClaim, SlateAnswer, SlateBindingRequest, SlateCallResult, SlateOperation, SlateShareRecord,
} from '@kinu.run/core';
import type { BlueprintReading, ShareUser } from '@kinu.run/core/slates';
import type { SlateCaller } from './slates/bindings';

/**
 * Every method a caller in this Worker reaches on the object that owns a
 * workspace: the slate operations an actor or a binding entrypoint makes AS a
 * caller. The caller is stamped by actor code on this stub transport; the
 * browser's own `@callable slate` mints the root caller locally and never
 * takes one.
 */
export interface WorkspaceOwnerRpc {
  slateAs(caller: SlateCaller, operation: SlateOperation): Promise<SlateCallResult>;
  slateBindingCallAs(caller: SlateCaller, id: string, name: string, request: SlateBindingRequest): Promise<SlateCallResult>;
  // Blueprints cross workspaces: the app host reads one from its owner and
  // admits it into the forker. Each answer is a value, refusal included.
  readBlueprint(share: string): Promise<SlateAnswer<BlueprintReading>>;
  blueprintBundle(share: string): Promise<SlateAnswer<BlueprintBundle>>;
  shareBlueprintWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<SlateShareRecord>>;
  admitBlueprint(bundle: BlueprintBundle): Promise<SlateAnswer<BlueprintFork>>;
  // Live shares cross workspaces the same way: the share rail forwards a
  // verified request to the owner's object, and the app host reads one share
  // row back for `/live/open`. The claim is built at the edge, never trusted.
  routeSlateShare(handle: string, claim: ShareViewerClaim, request: Request, pathname: string): Promise<Response>;
  readLiveShare(share: string): Promise<SlateAnswer<{ record: LiveShareRecord; title: string; description: string }>>;
  shareLiveWith(share: string, users: readonly ShareUser[]): Promise<SlateAnswer<LiveShareRecord>>;
  // A live-share fork asks the owner's object for the running slate's
  // skeleton: the row re-read, the grant's fork flag, and the caller's own
  // admission checked there — never trusted from the route.
  liveShareBundle(share: string, userId: string): Promise<SlateAnswer<BlueprintBundle>>;
}

/**
 * The owner object's own wire surface — every answer above that carries
 * `JsonValue`, as the JSON string it crosses a stub as.
 *
 * Hand-written rather than `DurableObjectStub<OrchestratorAgent>` because this
 * module is in the workerd probe project's graph, where the ambient `Env` the
 * orchestrator annotates does not exist (tests/workerd/tsconfig.json says so).
 * `rpc-surface.ts` holds the compile-time proof that this is the class's shape.
 */
export interface WorkspaceOwnerWire {
  slateAsWire(caller: SlateCaller, operation: SlateOperation): Promise<string>;
  slateBindingCallAsWire(caller: SlateCaller, id: string, name: string, request: SlateBindingRequest): Promise<string>;
  readBlueprintWire(share: string): Promise<string>;
  blueprintBundleWire(share: string): Promise<string>;
  shareBlueprintWithWire(share: string, users: readonly ShareUser[]): Promise<string>;
  admitBlueprintWire(bundle: BlueprintBundle): Promise<string>;
  routeSlateShare(handle: string, claim: ShareViewerClaim, request: Request, pathname: string): Promise<Response>;
  readLiveShareWire(share: string): Promise<string>;
  shareLiveWithWire(share: string, users: readonly ShareUser[]): Promise<string>;
  liveShareBundleWire(share: string, userId: string): Promise<string>;
}

export interface WorkspaceOwnerNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): WorkspaceOwnerWire;
}

/** The refusal half of an answer on the wire: core's `Refusal` under the
 *  `ok: false` tag, in the one vocabulary `ERROR_CODES` declares. */
const WireRefusalSchema = v.object({
  ok: v.literal(false),
  reason: v.picklist(ERROR_CODES),
  error: v.string(),
  execution: v.optional(v.object({ exitCode: v.number() })),
});

/** The two answers whose value shape core states across members rather than in
 *  one schema, composed here from the schemas core does export. */
const BlueprintReadingSchema = v.object({ record: SlateShareRecordSchema, view: v.omit(BlueprintViewSchema, ['id']) });

const LiveShareReadingSchema = v.object({ record: LiveShareRecordSchema, title: v.string(), description: v.string() });

const WireAnswerSchema = v.union([v.object({ ok: v.literal(true), value: JsonValueSchema }), WireRefusalSchema]);

/** One wire answer, checked against the shape core declares for its value. */
function answeredWire<Schema extends v.GenericSchema>(wire: string, value: Schema): SlateAnswer<v.InferOutput<Schema>> {
  const answer = v.parse(WireAnswerSchema, decodeJsonWire(wire));

  return answer.ok ? { ok: true, value: v.parse(value, answer.value) } : answer;
}

/**
 * The owner's object as an explicit adapter over its `…Wire` methods, never as
 * a stub annotated with `WorkspaceOwnerRpc`.
 *
 * Measured 2026-09-22: while this namespace answered `WorkspaceOwnerRpc`
 * directly, checking `Env.OrchestratorAgent` against it mapped `Rpc.Result`
 * over answers carrying the recursive `JsonValue`, and tsc gave up — TS2589 at
 * actor-agent.ts:4539 and user/shares-given.ts:45. Every member compared here
 * answers a `string`, so the recursion no longer crosses the stub and the
 * decode happens once, below.
 */
export function workspaceOwner(
  env: { OrchestratorAgent: WorkspaceOwnerNamespace },
  workspaceName: string,
): WorkspaceOwnerRpc {
  const owner = env.OrchestratorAgent.get(env.OrchestratorAgent.idFromName(workspaceName));

  return {
    slateAs: async (caller, operation) => answeredWire(await owner.slateAsWire(caller, operation), JsonValueSchema),
    slateBindingCallAs: async (caller, id, name, request) =>
      answeredWire(await owner.slateBindingCallAsWire(caller, id, name, request), JsonValueSchema),
    readBlueprint: async (share) => answeredWire(await owner.readBlueprintWire(share), BlueprintReadingSchema),
    blueprintBundle: async (share) => answeredWire(await owner.blueprintBundleWire(share), BlueprintBundleSchema),
    shareBlueprintWith: async (share, users) => answeredWire(await owner.shareBlueprintWithWire(share, users), SlateShareRecordSchema),
    admitBlueprint: async (bundle) => answeredWire(await owner.admitBlueprintWire(bundle), BlueprintForkSchema),
    routeSlateShare: (handle, claim, request, pathname) => owner.routeSlateShare(handle, claim, request, pathname),
    readLiveShare: async (share) => answeredWire(await owner.readLiveShareWire(share), LiveShareReadingSchema),
    shareLiveWith: async (share, users) => answeredWire(await owner.shareLiveWithWire(share, users), LiveShareRecordSchema),
    liveShareBundle: async (share, userId) => answeredWire(await owner.liveShareBundleWire(share, userId), BlueprintBundleSchema),
  };
}
