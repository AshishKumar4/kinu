// Workerd test-worker bindings, a separate tsc project from the production ../../env.d.ts so the two cannot drift.
// Augments `Cloudflare.Env`, which `cloudflare:test` and `cloudflare:workers` both read.
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type {
  AlarmDO, CacheWarmProbeDO, GatedDO, NeighbourDO, RetentionDO, StreamLifecycleDO,
} from './worker';
import type { EvictionProbeDO, WitnessDO } from './eviction-probe';
import type { HireObservation } from './hire-shapes';
import type { SpendProbeDO } from './spend-probe';
import type { OperationCost } from './sql-meter';
import type { HostileCalls, ProbeRecords } from './codex-egress-records';
import type { TerminalEffectProbeDO } from './terminal-effect-probe';
import type { DeviceOutputHubProbeDO, DeviceOutputWorkspaceProbeDO } from './device-output-probe';
import type { DbCapabilityProbeDO } from './db-capability-probe';
import type { FiberRecoveryProbeAgent } from './agent-fiber-recovery-probe';
import type { SocketCallProbeAgent } from './socket-call-probe';
import type { ForkSourceProbeDO, ForkTargetProbeDO } from './fork-probe';
import type { DeviceLedgerProbeDO } from './device-inflight-probe';
import type { ChatAnswers, SeedAnswer } from './store-reset-shapes';
import type { AddressedAnswers, AlarmAfterDestroy, FailedStartAnswers } from './addressed-name-shapes';
import type { CraftedFromNodeObservation, OnePlaneObservation, RelayedAnswer } from './agent-facet-shapes';
import type { AttributedLine } from './attribution-shapes';
import type {
  DeployFakeRefusal, DeployFakeServedBuild, DeployFakeStall, DeployFakeState, DeployFakeWeight,
} from './deploy-fake';
import type { DeployInputs, DeployRunPhase, DeploySnapshot } from '@kinu.run/core/deploy';
import type { FilesEioProbeDO } from './files-eio-probe';
import type { ParkedWritesProbeDO } from './parked-writes-probe';
import type { ComplexityProbeDO } from './complexity/complexity-probe';
import type { EffectAtomicityProbeDO } from './effect-atomicity-probe';
import type { PreviewPortProbeDO } from './preview-port-probe';
import type { CodemodeEgress } from '../../src/codemode-egress';
import type { CodemodeLauncher } from '../../src/codemode-sandbox';
import type { SlateBinding } from '../../src/slates/bindings';
import type {
  AgentLogEvent, CallRecord, DriveOnceInput, DriveOnceResult, ExerciseResult, HttpCall,
  PendingSteer, PendingSteerFile, PreparedConversation, QueuedConversation, QueueProbeMode, ReactorWake,
  ParityCompleted, ParityPrepared, RawChatProbeResult, WakeDriveResult, ChangeNotesCompleted, ChangeNotesPrepared, OwedRepliesRecovered,
} from './two-turn-shapes';
import type {
  DurabilityReservation, PreviewAnswer, RemovedSlate, RpcAnswer, ServedSlate,
} from './slate-durability-shapes';
import type { JsonValue, SlateCallResult } from '@kinu.run/core';

interface SlateActorRootRpc extends Rpc.DurableObjectBranded {
  craftedSlate(): Promise<string>;
  stopDuringHeldCalls(): Promise<{ answer: string; called: string[]; cancelled: string[] }>;
  code(mode: 'plan' | 'build', code: string): Promise<{ answer: string; file: string }>;
}

interface PlanAnnounceRpc extends Rpc.DurableObjectBranded {
  exercise(): Promise<{
    hops: Record<string, { ok: boolean; error: string | null }>;
    published: string[];
  }>;
}

/** Declared, not imported: a type import would drag the production worker graph in here. */
interface SurfaceControlRpc extends Rpc.WorkerEntrypointBranded {
  resetModelLog(): Promise<void>;
  holdProxyModel(): Promise<void>;
  proxyModelParked(count: number): Promise<number>;
  releaseProxyModel(): Promise<void>;
  holdQueuedModel(): Promise<void>;
  modelCalledWith(marker: string): Promise<void>;
  releaseQueuedModel(): Promise<void>;
  mintCliBearer(): Promise<string>;
}

interface UserSocketProbeRpc extends Rpc.DurableObjectBranded {
  deliverBareFrame(): Promise<'handled' | { readonly threw: string }>;
}

interface SlateEgressRpc extends Rpc.DurableObjectBranded {
  request(mode: 'plan' | 'build', target: string, redirect?: RequestRedirect): Promise<string>;
  publicPlanCall(): Promise<{ ok: boolean; reason?: string }>;
  unmediatedThenMediated(): Promise<{ unmediated: string; mediated: string; reused: string }>;
}

interface TwoTurnProbeRpc extends Rpc.DurableObjectBranded {
  signalProbe(): Promise<{ signalKind: string } | { threw: string }>;
  calls(): Promise<CallRecord[]>;
  exercise(): Promise<ExerciseResult>;
  httpCalls(): Promise<HttpCall[]>;
  httpReset(): Promise<void>;
  driveOnce(input: DriveOnceInput): Promise<DriveOnceResult>;
  queuedConversation(mode: QueueProbeMode): Promise<QueuedConversation>;
  prepareQueuedConversation(mode: QueueProbeMode): Promise<PreparedConversation>;
  replayQueuedConversation(prepared: PreparedConversation): Promise<{ steers: PendingSteer[]; steerFiles: PendingSteerFile[] }>;
  completeQueuedConversation(prepared: PreparedConversation): Promise<{ http: HttpCall[]; steers: PendingSteer[]; steerFiles: PendingSteerFile[]; transcript: Array<{ id: string; role: string }>; runEnds: Array<{ runId: string; reason: string }> }>;
  pendingSteersFor(workspace: string): Promise<PendingSteer[]>;
  claimEventWorkspace(): Promise<{ workspace: string; owner: string }>;
  agentLogEventsFor(workspace: string): Promise<AgentLogEvent[]>;
  seedStaleDrainEventFor(workspace: string, marker: string): Promise<void>;
  runEventWakeFor(workspace: string, marker: string): Promise<void>;
  claimReactorWakeWorkspace(): Promise<{ workspace: string; owner: string }>;
  reactorWake(workspace: string, owner: string, body: string): Promise<ReactorWake>;
  firstChat(): Promise<{ http: HttpCall[]; steers: PendingSteer[]; transcript: Array<{ id: string; role: string }>; sleepTimeSettled: number }>;
  twinSends(): Promise<{ http: HttpCall[]; transcript: Array<{ id: string; role: string }>; steers: PendingSteer[]; runEnds: Array<{ runId: string; reason: string }> }>;
  evalAbort(): Promise<{ receipt: string | null; alive: boolean }>;
  prepareChangeNotes(): Promise<ChangeNotesPrepared>;
  completeChangeNotes(workspace: string): Promise<ChangeNotesCompleted>;
  refusedChangeNotes(): Promise<{ readonly sent: boolean; readonly owed: { readonly sends: number; readonly cards: number } }>;
  claimUnderRecovery(): Promise<{ readonly held: string | null; readonly settled: string | null }>;
  seedOwedReplyWorkspace(): Promise<string>;
  recoverOwedReplies(workspace: string): Promise<OwedRepliesRecovered>;
  hostedActorTab(): Promise<{ name: string; snapshot: string; jobs: string; frames: number }>;
  firstChatAfterGenesis(): Promise<{ http: HttpCall[]; steers: PendingSteer[]; inbox: { busy: boolean }; landed: string | null; transcript: Array<{ id: string; role: string }>; failures: Array<{ event: string; code: string; cause: string }> }>;
  parityPrepare(): Promise<ParityPrepared>;
  parityComplete(prepared: ParityPrepared): Promise<ParityCompleted>;
  longTurnCost(priorDeltas: number): Promise<{ cost: OperationCost; historyReads: number }>;
  backgroundWakeConversation(): Promise<WakeDriveResult>;
  rawChat(): Promise<RawChatProbeResult>;
}

/** The shipped root, sealed as the product seals it: the call `getAgentByName` makes on every stub, which it answers,
 *  and the inherited members it must refuse (`tests/helpers/rpc-denied.ts`), declared so a test can make each call. */
interface SealedOrchestratorRpc extends Rpc.DurableObjectBranded {
  __unsafe_ensureInitialized(): Promise<void>;
  sql(): Promise<void>;
  destroy(): Promise<void>;
  setState(): Promise<void>;
  stash(): Promise<void>;
  _cf_invokeSubAgent(): Promise<void>;
  _cf_invokeSubAgentPath(): Promise<void>;
  _cf_invokeAgentPath(): Promise<void>;
  _cf_invokeStubMethod(): Promise<void>;
  schedule(): Promise<void>;
  runFiber(): Promise<void>;
  keepAlive(): Promise<void>;
}

interface CodexEgressProbeRpc extends Rpc.DurableObjectBranded, HostileCalls {
  forward(ownerUserId: string, callId: string, request: Request): Promise<Response>;
  cancel(callId: string): void;
}

interface CodexEgressRecordsRpc extends Rpc.WorkerEntrypointBranded {
  read(id: string): ProbeRecords;
}

interface HireProbeRpc extends Rpc.DurableObjectBranded {
  setup(workspace: string, model: string, script: import('./hire-shapes').ChildScript): Promise<void>;
  releaseChild(): Promise<void>;
  childSpoke(): Promise<void>;
  callerObserved(): Promise<void>;
  openHire(workspace: string, prompt: string): Promise<void>;
  reenter(workspace: string): Promise<void>;
  wakeReturned(workspace: string): Promise<void>;
  /** Every delegated turn ended and every answered task agent retired. */
  settled(workspace: string): Promise<void>;
  stopChild(workspace: string): Promise<void>;
  dismissChild(workspace: string): Promise<string>;
  /** The dismissal's answer, as JSON. */
  dismissAnswer(workspace: string, name: string): Promise<string>;
  observe(workspace: string): Promise<HireObservation>;
  archiveSections(workspace: string): Promise<import('./hire-shapes').ArchiveSections>;
  jobWindowArmed(workspace: string, count: number): Promise<void>;
  outrunJobWindow(workspace: string): Promise<void>;
  openJobGate(workspace: string): Promise<void>;
  redeliverJobWake(workspace: string, jobId: string): Promise<void>;
  loseJobFiber(workspace: string, jobId: string): Promise<number>;
  jobRows(workspace: string): Promise<import('./hire-shapes').JobRow[]>;
}

interface SlateProcessProbeRpc extends Rpc.DurableObjectBranded {
  start(start?: {
    source?: string; bindChain?: boolean; cred?: VfsCred;
    browser?: string; project?: Record<string, JsonValue>; app?: { port: number } | null;
  }): Promise<void>;
  stop(): Promise<void>;
  esbuildInThisIsolate(): Promise<boolean>;
  facetImages(): Promise<string[]>;
  call(method: string, args?: JsonValue[], chain?: string[]): Promise<{ ok: true; value: string } | { ok: false; error: string }>;
  socket(method: string, args?: JsonValue[]): Promise<{ ok?: boolean; value?: string; error?: string }>;
  route(path?: string, chain?: string[]): Promise<{ status: number; body: string; contentType: string | null }>;
  artifacts(): Promise<{ application: string; client?: string; shell?: string }>;
  paths(): Promise<{ kinuInSlateRoot: boolean; entries: string[] }>;
  compileProbe(source: string | null, cred?: VfsCred, project?: Record<string, JsonValue>): Promise<{ ok?: boolean; code?: string; detail?: string }>;
  seedPrivateSource(): Promise<void>;
  seedGroupSource(): Promise<void>;
  readPrivateSourceAsAgent(): Promise<{ content?: string; error?: string }>;
}

interface AccountResetProbeRpc extends Rpc.DurableObjectBranded {
  seed(): Promise<{ hashes: Record<'ws-alpha' | 'ws-beta', string | null> }>;
  counts(): Promise<Record<string, number>>;
  hashes(): Promise<Record<'ws-alpha' | 'ws-beta', string | null>>;
  reset(): Promise<{ ok: true; workspaces: number }>;
  freshProfile(): Promise<{ email: string; displayName: string | null; onboardedAt: number | null; workspaceCount: number } | null>;
  refuseTeardownOf(workspace: string, refuse: boolean): Promise<void>;
  pendingDeletes(): Promise<string[]>;
  receivedFrom(): Promise<string[]>;
  ownerDeleted(ownerUserId: string): Promise<void>;
  resetRefused(): Promise<string>;
}

interface AgentFacetProbeRpc extends Rpc.DurableObjectBranded {
  deletedWorkspaceFacet(workspace: string): Promise<{ readonly before: string[]; readonly after: string[] }>;
  onePlane(workspace: string, agent: string): Promise<OnePlaneObservation>;
  swarmNode(workspace: string): Promise<ReadableStream<Uint8Array>>;
  craftedFromNode(workspace: string): Promise<CraftedFromNodeObservation>;
  agentWorkspaceAnswer(workspace: string, agent: string): Promise<RelayedAnswer<Readonly<Record<string, string>> | null>>;
  agentWorkspaceListing(workspace: string, agent: string): Promise<RelayedAnswer<readonly { readonly key: string; readonly kind: string }[]>>;
  slateBindingAnswer(workspace: string): Promise<RelayedAnswer<SlateCallResult>>;
  programHostAnswer(workspace: string): Promise<RelayedAnswer<Readonly<Record<string, string>> | null>>;
  swarmJobNode(workspace: string): Promise<ReadableStream<Uint8Array>>;
  jobWindowArmed(workspace: string, count: number): Promise<void>;
  outrunJobWindow(workspace: string): Promise<void>;
  jobRows(workspace: string): Promise<import('./hire-shapes').JobRow[]>;
  cancelJob(workspace: string, jobId: string): Promise<{ ok: boolean }>;
  taskEvents(workspace: string, actorId: string): Promise<number>;
}

interface AddressedNameProbeRpc extends Rpc.DurableObjectBranded {
  claimAndEvict(workspace: string): Promise<string>;
  idThenNamed(workspace: string): Promise<AddressedAnswers>;
  rpcFirst(workspace: string): Promise<{ before: number; spend: string; after: number }>;
  failedStartThenDestroy(workspace: string): Promise<FailedStartAnswers>;
  siblingStarts(): Promise<{ spend: string; starts: number; alarm: string; left: { identity: number; actors: number } }>;
  alarmAfterDestroy(workspace: string): Promise<AlarmAfterDestroy>;
}

interface AttributionProbeRpc extends Rpc.DurableObjectBranded {
  logThreeWays(workspace: string): Promise<void>;
  releaseLineOf(workspace: string, other: string): Promise<string[]>;
  written(workspace: string, count: number): Promise<AttributedLine[]>;
}

interface StoreResetProbeRpc extends Rpc.DurableObjectBranded {
  plantRefusedWorkspace(workspace: string): Promise<string>;
  seed(workspace: string): Promise<SeedAnswer>;
  chat(workspace: string): Promise<ChatAnswers>;
  wake(workspace: string): Promise<string>;
  exportedLines(workspace: string): Promise<number>;
}

interface SlateDurabilityProbeRpc extends Rpc.DurableObjectBranded {
  serveSlate(input: {
    workspace: string; owner: string; id: string; body: string; preferredPort?: number;
  }): Promise<ServedSlate>;
  portReservations(workspace: string): Promise<DurabilityReservation[]>;
  programOnWhiteboard(input: { workspace: string; owner: string; program: string }): Promise<string>;
  forgetActivation(workspace: string): Promise<void>;
  pendingNimbusTasks(workspace: string): Promise<{ tasks: Array<{ id: string; time: number }>; alarm: number | null }>;
  drivePreview(url: string): Promise<PreviewAnswer>;
  rpcPreview(url: string, method: string, args?: JsonValue[]): Promise<RpcAnswer>;
  removeSlate(workspace: string, id: string): Promise<RemovedSlate>;
  putPicture(workspace: string, slate: string, digest: string): Promise<void>;
  pictureKeys(workspace: string): Promise<string[]>;
  openWorkspace(workspace: string, owner: string): Promise<void>;
  runInWorkspace(workspace: string, command: string): Promise<{ exitCode: number; stdout: string }>;
  readWorkspaceFile(workspace: string, path: string): Promise<string | null>;
  driveTerminal(workspace: string, line: string, until: string): Promise<
    | { ok: true; frames: string[]; output: string }
    | { ok: false; error: string }
  >;
}


/** Spelled flat: the recursive `JsonValue` makes the stub's serializability check exceed the instantiation budget. */
type ProbeAnswer = { ok: true; value: unknown } | { ok: false; reason: string; error?: string };

interface SlateShareProbeRpc extends Rpc.DurableObjectBranded {
  start(): Promise<void>;
  previewAsHire(): Promise<{ preview: ProbeAnswer; removed: ProbeAnswer; left: boolean }>;
  share(approved?: readonly { binding: string; member: string }[]): Promise<ProbeAnswer>;
  liveShares(): Promise<ProbeAnswer>;
  importBlueprint(): Promise<{ fork: string; running: number }>;
  viewerHop(handle: string, claim: { userId: string | null; source: string; consented: boolean }): Promise<string>;
  viewerSocketAcross(
    handle: string, claim: { userId: string | null; source: string; consented: boolean }, share: string, change: 'revoke' | 'spend',
  ): Promise<{ before: string | null; after: string; late: string }>;
  viewerFetch(handle: string, claim: { userId: string | null; source: string; consented: boolean }): Promise<{ status: number; body: string }>;
  viewerBatch(handle: string, claim: { userId: string | null; source: string; consented: boolean }): Promise<{ probe: string | null; mutateError: string }>;
  viewerSocket(handle: string, claim: { userId: string | null; source: string; consented: boolean }): Promise<{ probe: string | null; mutateError: string }>;
  replay(share: string): Promise<ProbeAnswer>;
  requests(share: string): Promise<ProbeAnswer>;
  revoke(share: string): Promise<ProbeAnswer>;
  stopped(): Promise<boolean>;
}


/** Declared, not imported: the probe compiles under the production project. */
interface DeployRunProbeRpc extends Rpc.DurableObjectBranded {
  open(runId: string, keyDigest: string): Promise<void>;
  admits(runKey: string): Promise<boolean>;
  holdAuthorization(verifier: string): Promise<string>;
  landAuthorization(clientId: string, redirectUri: string, code: string, state: string): Promise<boolean>;
  landToken(accessToken: string, refreshToken: string): Promise<void>;
  authorized(): Promise<boolean>;
  accounts(): Promise<readonly { id: string; name: string }[]>;
  snapshot(): Promise<DeploySnapshot>;
  start(inputs: DeployInputs): Promise<DeploySnapshot>;
  retry(stepId: string): Promise<DeploySnapshot>;
  heldCredentials(): Promise<readonly string[]>;
  forget(): Promise<void>;
  alarmAt(): Promise<number>;
  armedAt(): Promise<number>;
  settledAfter(states: readonly DeployRunPhase[]): Promise<DeploySnapshot>;
  reportAfterAlarm(): Promise<DeploySnapshot>;
  expireSoon(): Promise<boolean>;
  rowText(): Promise<string>;
  abort(reason: string): Promise<void>;
}

interface DeployFakeControlRpc extends Rpc.WorkerEntrypointBranded {
  reset(): Promise<void>;
  state(): Promise<DeployFakeState>;
  refuseOnce(refusal: DeployFakeRefusal): Promise<void>;
  serve(build: DeployFakeServedBuild): Promise<void>;
  publish(build: DeployFakeServedBuild): Promise<void>;
  stallOnce(stall: DeployFakeStall): Promise<void>;
  stallReached(): Promise<void>;
  releaseStall(): Promise<void>;
  weigh(weight: DeployFakeWeight): Promise<void>;
  expireGrant(expiresIn: number): Promise<void>;
  existing(): Promise<void>;
}

interface UpdatesSession {
  userId: string;
  email: string;
  sub: string;
  provider?: string;
  cliScopes?: readonly string[];
}

interface UpdatesProbeRpc extends Rpc.WorkerEntrypointBranded {
  hit(method: string, path: string, session: UpdatesSession): Promise<{ status: number; body: string }>;
}

interface DoorProbeAnswer {
  status: number;
  body: string;
  location: string;
  setCookie: readonly string[];
}

interface DeployDoorProbeRpc extends Rpc.WorkerEntrypointBranded {
  hit(method: string, path: string, headers?: Readonly<Record<string, string>>): Promise<DoorProbeAnswer>;
}

declare global {
  namespace Cloudflare {
    interface Env {
      SLATE_EGRESS_PROBE: DurableObjectNamespace<SlateEgressRpc>;
      RETENTION: DurableObjectNamespace<RetentionDO>;
      NEIGHBOUR: DurableObjectNamespace<NeighbourDO>;
      GATED: DurableObjectNamespace<GatedDO>;
      ALARMED: DurableObjectNamespace<AlarmDO>;
      CACHE_WARM_PROBE: DurableObjectNamespace<CacheWarmProbeDO>;
      EVICTION_PROBE: DurableObjectNamespace<EvictionProbeDO>;
      WITNESS: DurableObjectNamespace<WitnessDO>;
      SPEND_PROBE: DurableObjectNamespace<SpendProbeDO>;
      TERMINAL_EFFECT_PROBE: DurableObjectNamespace<TerminalEffectProbeDO>;
      DB_CAPABILITY_PROBE: DurableObjectNamespace<DbCapabilityProbeDO>;
      FIBER_RECOVERY_PROBE: DurableObjectNamespace<FiberRecoveryProbeAgent>;
      SOCKET_CALL_PROBE: DurableObjectNamespace<SocketCallProbeAgent>;
      FORK_SOURCE: DurableObjectNamespace<ForkSourceProbeDO>;
      FORK_TARGET: DurableObjectNamespace<ForkTargetProbeDO>;
      STREAM_LIFECYCLE: DurableObjectNamespace<StreamLifecycleDO>;
      DEVICE_LEDGER_PROBE: DurableObjectNamespace<DeviceLedgerProbeDO>;
      DEVICE_OUTPUT_HUB_PROBE: DurableObjectNamespace<DeviceOutputHubProbeDO>;
      DEVICE_OUTPUT_WORKSPACE_PROBE: DurableObjectNamespace<DeviceOutputWorkspaceProbeDO>;
      FILES_EIO_PROBE: DurableObjectNamespace<FilesEioProbeDO>;
      PARKED_WRITES_PROBE: DurableObjectNamespace<ParkedWritesProbeDO>;
      COMPLEXITY_PROBE: DurableObjectNamespace<ComplexityProbeDO>;
      EFFECT_ATOMICITY_PROBE: DurableObjectNamespace<EffectAtomicityProbeDO>;
      PREVIEW_PORT_PROBE: DurableObjectNamespace<PreviewPortProbeDO>;
      SLATE_PROCESS_PROBE: DurableObjectNamespace<SlateProcessProbeRpc>;
      SLATE_SHARE_PROBE: DurableObjectNamespace<SlateShareProbeRpc>;
      SLATE_ACTOR_ROOT: DurableObjectNamespace<SlateActorRootRpc>;
      PLAN_ANNOUNCE_ROOT: DurableObjectNamespace<PlanAnnounceRpc>;
      TWO_TURN_PROBE: DurableObjectNamespace<TwoTurnProbeRpc>;
      HIRE_PROBE: DurableObjectNamespace<HireProbeRpc>;
      HIRE_WORKSPACE: DurableObjectNamespace<import('agents').Agent<Cloudflare.Env>>;
      CODEX_EGRESS_PROBE: DurableObjectNamespace<CodexEgressProbeRpc>;
      CODEX_EGRESS_RECORDS: Service<CodexEgressRecordsRpc>;
      USER_SOCKET_PROBE: DurableObjectNamespace<UserSocketProbeRpc>;
      SLATE_DURABILITY_PROBE: DurableObjectNamespace<SlateDurabilityProbeRpc>;
      DELETE_ALL_PROBE: DurableObjectNamespace<import('./delete-all-probe').DeleteAllProbeDO>;
      ACCOUNT_RESET_PROBE: DurableObjectNamespace<AccountResetProbeRpc>;
      STORE_RESET_PROBE: DurableObjectNamespace<StoreResetProbeRpc>;
      ADDRESSED_NAME_PROBE: DurableObjectNamespace<AddressedNameProbeRpc>;
      AGENT_FACET_PROBE: DurableObjectNamespace<AgentFacetProbeRpc>;
      ATTRIBUTION_PROBE: DurableObjectNamespace<AttributionProbeRpc>;
      SEALED_ORCHESTRATOR: DurableObjectNamespace<SealedOrchestratorRpc>;
  // Readiness refusal must serialise over Workers RPC as data, not a thrown class name; not a sandbox stub.
      LOADER: WorkerLoader;
      /** The production Worker entry hosted by `public-surface-probe`, WebSocket upgrades included. */
      PUBLIC_SURFACE: Fetcher;
      HIRE_APP: Fetcher;
      SURFACE_CONTROL: Service<SurfaceControlRpc>;
      /** Production deploy run, hosted by `deploy-probe` as a subclass with read-only storage windows. */
      DEPLOY_RUN_PROBE: DurableObjectNamespace<DeployRunProbeRpc>;
      DEPLOY_FAKE: Service<DeployFakeControlRpc>;
      UPDATES_PROBE: Service<UpdatesProbeRpc>;
      DEPLOY_DOOR_PROBE: Service<DeployDoorProbeRpc>;
    }

    /** `exports.CodemodeEgress` is a loopback stub here as in production. */
    interface GlobalProps {
      mainModule: {
        SlateBinding: typeof SlateBinding;
        CodemodeEgress: typeof CodemodeEgress;
        CodemodeLauncher: typeof CodemodeLauncher;
        SlateChainProbe: typeof SlateChainProbe;
        default: ExportedHandler<Cloudflare.Env>;
      };
    }
  }
}
