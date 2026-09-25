// Workerd test-worker bindings, a separate tsc project from the production ../../env.d.ts so the two cannot drift.
// Augments `Cloudflare.Env`, which `cloudflare:test` and `cloudflare:workers` both read.
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type {
  AlarmDO, CacheWarmProbeDO, GatedDO, NeighbourDO, RetentionDO, SocketDO, StreamLifecycleDO, TransactionDO,
} from './worker';
import type { EvictionProbeDO, WitnessDO } from './eviction-probe';
import type { HireObservation } from './hire-shapes';
import type { SpendProbeDO } from './spend-probe';
import type { HostileCalls, ProbeRecords } from './codex-egress-records';
import type { TerminalEffectProbeDO } from './terminal-effect-probe';
import type { DbCapabilityProbeDO } from './db-capability-probe';
import type { FiberRecoveryProbeAgent } from './agent-fiber-recovery-probe';
import type { ForkSourceProbeDO, ForkTargetProbeDO } from './fork-probe';
import type { DeviceLedgerProbeDO } from './device-inflight-probe';
import type { ChatAnswers, SeedAnswer } from './store-reset-shapes';
import type { AddressedAnswers } from './addressed-name-shapes';
import type {
  DeployFakeRefusal, DeployFakeServedBuild, DeployFakeStall, DeployFakeState, DeployFakeWeight,
} from './deploy-fake';
import type { DeployInputs, DeployRunPhase, DeploySnapshot } from '@kinu.run/core/deploy';
import type { FilesEioProbeDO } from './files-eio-probe';
import type { ComplexityProbeDO } from './complexity/complexity-probe';
import type { PreviewPortProbeDO } from './preview-port-probe';
import type { CodemodeEgress } from '../../src/codemode-egress';
import type { DevboxNotReadyProbeDO } from './devbox-not-ready-probe';
import type { SlateBinding } from '../../src/slates/bindings';
import type {
  AgentLogEvent, CallRecord, DriveOnceInput, DriveOnceResult, ExerciseResult, HttpCall,
  PendingSteer, PendingSteerFile, PreparedConversation, QueuedConversation, QueueProbeMode, ReactorWake,
  ParityCompleted, ParityPrepared, RawChatProbeResult, WakeDriveResult, WakeHoldPlacement,
} from './two-turn-shapes';
import type {
  DurabilityReservation, PreviewAnswer, RemovedSlate, RpcAnswer, ServedSlate,
} from './slate-durability-shapes';
import type { JsonValue } from '@kinu.run/core';

interface SlateActorRootRpc extends Rpc.DurableObjectBranded {
  craftedSlate(): Promise<string>;
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
  hostedActorTab(): Promise<{ name: string; snapshot: string; jobs: string; frames: number }>;
  firstChatAfterGenesis(): Promise<{ http: HttpCall[]; steers: PendingSteer[]; inbox: { busy: boolean }; landed: string | null; transcript: Array<{ id: string; role: string }>; failures: Array<{ event: string; code: string; cause: string }> }>;
  parityPrepare(): Promise<ParityPrepared>;
  parityComplete(prepared: ParityPrepared): Promise<ParityCompleted>;
  backgroundWakeConversation(where: WakeHoldPlacement): Promise<WakeDriveResult>;
  rawChat(): Promise<RawChatProbeResult>;
  longTurn(priorTurns: number, deltas: number, priorDeltas?: number): Promise<{ priorMs: number; longMs: number; calls: number }>;
}

interface CodexEgressProbeRpc extends Rpc.DurableObjectBranded, HostileCalls {
  forward(ownerUserId: string, callId: string, request: Request): Promise<Response>;
  cancel(callId: string): void;
}

interface CodexEgressRecordsRpc extends Rpc.WorkerEntrypointBranded {
  read(id: string): ProbeRecords;
}

interface HireProbeRpc extends Rpc.DurableObjectBranded {
  setup(workspace: string, model: string, script: 'answer' | 'throw' | 'park'): Promise<void>;
  releaseChild(): Promise<void>;
  childSpoke(): Promise<void>;
  callerObserved(): Promise<void>;
  openHire(workspace: string, prompt: string): Promise<void>;
  msgSent(): Promise<void>;
  reenter(workspace: string): Promise<void>;
  wakeReturned(workspace: string): Promise<void>;
  stopChild(workspace: string): Promise<void>;
  dismissChild(workspace: string): Promise<string>;
  observe(workspace: string): Promise<HireObservation>;
}

interface SlateProcessProbeRpc extends Rpc.DurableObjectBranded {
  start(start?: {
    source?: string; bindChain?: boolean; cred?: VfsCred;
    browser?: string; project?: Record<string, JsonValue>; app?: { port: number } | null;
  }): Promise<void>;
  stop(): Promise<void>;
  facetImages(): Promise<string[]>;
  call(method: string, args?: JsonValue[], chain?: string[]): Promise<{ ok: true; value: string } | { ok: false; error: string }>;
  socket(method: string, args?: JsonValue[]): Promise<{ ok?: boolean; value?: string; error?: string }>;
  route(path?: string, chain?: string[]): Promise<{ status: number; body: string; contentType: string | null }>;
  artifacts(): Promise<{ application: string; client?: string; shell?: string }>;
  paths(): Promise<{ kinuInSlateRoot: boolean; entries: string[] }>;
  compileProbe(source: string, cred?: VfsCred): Promise<{ ok?: boolean; code?: string; detail?: string }>;
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
}

interface AddressedNameProbeRpc extends Rpc.DurableObjectBranded {
  claimAndEvict(workspace: string): Promise<string>;
  idThenNamed(workspace: string): Promise<AddressedAnswers>;
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
      TRANSACTION: DurableObjectNamespace<TransactionDO>;
      SOCKET: DurableObjectNamespace<SocketDO>;
      ALARMED: DurableObjectNamespace<AlarmDO>;
      CACHE_WARM_PROBE: DurableObjectNamespace<CacheWarmProbeDO>;
      EVICTION_PROBE: DurableObjectNamespace<EvictionProbeDO>;
      WITNESS: DurableObjectNamespace<WitnessDO>;
      SPEND_PROBE: DurableObjectNamespace<SpendProbeDO>;
      TERMINAL_EFFECT_PROBE: DurableObjectNamespace<TerminalEffectProbeDO>;
      DB_CAPABILITY_PROBE: DurableObjectNamespace<DbCapabilityProbeDO>;
      FIBER_RECOVERY_PROBE: DurableObjectNamespace<FiberRecoveryProbeAgent>;
      FORK_SOURCE: DurableObjectNamespace<ForkSourceProbeDO>;
      FORK_TARGET: DurableObjectNamespace<ForkTargetProbeDO>;
      STREAM_LIFECYCLE: DurableObjectNamespace<StreamLifecycleDO>;
      DEVICE_LEDGER_PROBE: DurableObjectNamespace<DeviceLedgerProbeDO>;
      FILES_EIO_PROBE: DurableObjectNamespace<FilesEioProbeDO>;
      COMPLEXITY_PROBE: DurableObjectNamespace<ComplexityProbeDO>;
      PREVIEW_PORT_PROBE: DurableObjectNamespace<PreviewPortProbeDO>;
      SLATE_PROCESS_PROBE: DurableObjectNamespace<SlateProcessProbeRpc>;
      SLATE_SHARE_PROBE: DurableObjectNamespace<SlateShareProbeRpc>;
      SLATE_ACTOR_ROOT: DurableObjectNamespace<SlateActorRootRpc>;
      PLAN_ANNOUNCE_ROOT: DurableObjectNamespace<PlanAnnounceRpc>;
      TWO_TURN_PROBE: DurableObjectNamespace<TwoTurnProbeRpc>;
      HIRE_PROBE: DurableObjectNamespace<HireProbeRpc>;
      CODEX_EGRESS_PROBE: DurableObjectNamespace<CodexEgressProbeRpc>;
      CODEX_EGRESS_RECORDS: Service<CodexEgressRecordsRpc>;
      USER_SOCKET_PROBE: DurableObjectNamespace<UserSocketProbeRpc>;
      SLATE_DURABILITY_PROBE: DurableObjectNamespace<SlateDurabilityProbeRpc>;
      ACCOUNT_RESET_PROBE: DurableObjectNamespace<AccountResetProbeRpc>;
      STORE_RESET_PROBE: DurableObjectNamespace<StoreResetProbeRpc>;
      ADDRESSED_NAME_PROBE: DurableObjectNamespace<AddressedNameProbeRpc>;
  // Readiness refusal must serialise over Workers RPC as data, not a thrown class name; not a sandbox stub.
  DEVBOX_NOT_READY_PROBE: DurableObjectNamespace<DevboxNotReadyProbeDO>;
      LOADER: WorkerLoader;
      /** The production Worker entry hosted by `public-surface-probe`, WebSocket upgrades included. */
      PUBLIC_SURFACE: Fetcher;
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
        SlateChainProbe: typeof SlateChainProbe;
      };
    }
  }
}
