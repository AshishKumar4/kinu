// Bindings of the workerd test worker. Deliberately separate from
// ../../env.d.ts, which declares the PRODUCTION `Env` and is compiled by
// packages/cf-backend/tsconfig.json — this directory is its own tsc project
// (see ./tsconfig.json) precisely so the two binding surfaces cannot drift into
// each other. `cloudflare:test` and `cloudflare:workers` both read
// `Cloudflare.Env`, which is why the augmentation targets that namespace and
// not the bare global `Env`.
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type {
  AlarmDO, CacheWarmProbeDO, GatedDO, NeighbourDO, RetentionDO, SocketDO, SteerProbeDO, StreamLifecycleDO, TransactionDO,
} from './worker';
import type { EvictionProbeDO, WitnessDO } from './eviction-probe';
import type { HireObservation } from './hire-shapes';
import type { CappedTurnProbeDO, UnboundedTurnProbeDO } from './step-cap-probe';
import type { SpendProbeDO } from './spend-probe';
import type { TerminalEffectProbeDO } from './terminal-effect-probe';
import type { DbCapabilityProbeDO } from './db-capability-probe';
import type { FiberRecoveryProbeAgent } from './agent-fiber-recovery-probe';
import type { ForkSourceProbeDO, ForkTargetProbeDO } from './fork-probe';
import type { DeviceLedgerProbeDO } from './device-inflight-probe';
import type { FilesEioProbeDO } from './files-eio-probe';
import type { PreviewPortProbeDO } from './preview-port-probe';
import type { CodemodeEgress } from '../../src/codemode-egress';
import type { DevboxNotReadyProbeDO } from './devbox-not-ready-probe';
import type { SlateBinding } from '../../src/slates/bindings';
import type {
  AgentLogEvent, ArmedWake, CallRecord, DriveOnceInput, DriveOnceResult, ExerciseResult, HttpCall,
  PendingSteer, PendingSteerFile, PreparedConversation, QueueProbeMode,
  ParityCompleted, ParityPrepared, WakeDriveResult, WakeHoldPlacement,
} from './two-turn-shapes';
import type {
  DurabilityReservation, PreviewAnswer, RemovedSlate, RpcAnswer, ServedSlate,
} from './slate-durability-shapes';
import type { JsonValue } from '@kinu.run/core';
import type { ExecutorInfo } from '@kinu.run/core';

interface SlateActorRootRpc extends Rpc.DurableObjectBranded {
  craftedSlate(): Promise<string>;
  exercise(family: 'subordinate' | 'exploration'): Promise<{ answer: ExecutorInfo[]; browserCallable: boolean }>;
  code(mode: 'plan' | 'build', code: string): Promise<{ answer: string; file: string }>;
}

interface PlanAnnounceRpc extends Rpc.DurableObjectBranded {
  exercise(): Promise<{
    hops: Record<string, { ok: boolean; error: string | null }>;
    published: string[];
  }>;
}

/** `public-surface-probe`'s control entrypoint. Declared here rather than
 *  imported: that file is compiled by the cf-backend project against the
 *  production `Env`, and a type import would drag the whole worker in here. */
interface SurfaceControlRpc extends Rpc.WorkerEntrypointBranded {
  resetModelLog(): Promise<void>;
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
  queuedConversation(mode: QueueProbeMode): Promise<HttpCall[]>;
  prepareQueuedConversation(mode: QueueProbeMode): Promise<PreparedConversation>;
  replayQueuedConversation(prepared: PreparedConversation): Promise<{ steers: PendingSteer[]; steerFiles: PendingSteerFile[] }>;
  completeQueuedConversation(prepared: PreparedConversation): Promise<{ http: HttpCall[]; steers: PendingSteer[]; steerFiles: PendingSteerFile[]; transcript: Array<{ id: string; role: string }>; runEnds: Array<{ runId: string; reason: string }> }>;
  pendingSteersFor(workspace: string): Promise<PendingSteer[]>;
  claimEventWorkspace(): Promise<{ workspace: string; owner: string }>;
  agentLogEventsFor(workspace: string): Promise<AgentLogEvent[]>;
  seedStaleDrainEventFor(workspace: string, marker: string): Promise<void>;
  runEventWakeFor(workspace: string, marker: string): Promise<void>;
  claimReactorWakeWorkspace(): Promise<{ workspace: string; owner: string }>;
  publishPeerEvent(workspace: string, owner: string, body: string): Promise<ArmedWake[]>;
  armedWakesFor(workspace: string): Promise<ArmedWake[]>;
  driveArmedWakesFor(workspace: string): Promise<string[]>;
  runStartCausesFor(workspace: string): Promise<string[]>;
  awaitWireMarker(marker: string): Promise<void>;
  firstChat(): Promise<{ http: HttpCall[]; steers: PendingSteer[]; transcript: Array<{ id: string; role: string }>; factsCompressed: number }>;
  twinSends(): Promise<{ http: HttpCall[]; transcript: Array<{ id: string; role: string }>; steers: PendingSteer[]; runEnds: Array<{ runId: string; reason: string }> }>;
  evalAbort(): Promise<{ receipt: string | null; alive: boolean }>;
  hostedActorTab(): Promise<{ name: string; snapshot: string; tasks: string; frames: number }>;
  firstChatAfterGenesis(): Promise<{ http: HttpCall[]; steers: PendingSteer[]; inbox: { busy: boolean }; landed: string | null; transcript: Array<{ id: string; role: string }>; failures: Array<{ event: string; code: string; cause: string }> }>;
  parityPrepare(): Promise<ParityPrepared>;
  parityComplete(prepared: ParityPrepared): Promise<ParityCompleted>;
  backgroundWakeConversation(where: WakeHoldPlacement): Promise<WakeDriveResult>;
}

interface HireProbeRpc extends Rpc.DurableObjectBranded {
  setup(workspace: string, model: string, script: 'answer' | 'throw' | 'park'): Promise<void>;
  releaseChild(): Promise<void>;
  childSpoke(): Promise<void>;
  callerObserved(): Promise<void>;
  openHire(workspace: string, prompt: string): Promise<void>;
  msgSent(): Promise<void>;
  reenter(workspace: string): Promise<void>;
  observe(workspace: string): Promise<HireObservation>;
}

interface SlateProcessProbeRpc extends Rpc.DurableObjectBranded {
  start(source?: string, bindChain?: boolean, cred?: VfsCred, browser?: string, project?: Record<string, JsonValue>, app?: { port: number } | null): Promise<void>;
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

interface SlateDurabilityProbeRpc extends Rpc.DurableObjectBranded {
  serveSlate(input: {
    workspace: string; owner: string; id: string; body: string; preferredPort?: number;
  }): Promise<ServedSlate>;
  portReservations(workspace: string): Promise<DurabilityReservation[]>;
  drivePreview(url: string): Promise<PreviewAnswer>;
  rpcPreview(url: string, method: string, args?: JsonValue[]): Promise<RpcAnswer>;
  removeSlate(workspace: string, id: string): Promise<RemovedSlate>;
  runInWorkspace(workspace: string, command: string): Promise<{ exitCode: number; stdout: string }>;
}


/** The wire projection of `SlateCallResult` - spelled flat because declaring
 *  the recursive `JsonValue` in the RPC surface makes the stub's
 *  serializability check exceed the type-instantiation budget. */
type ProbeAnswer = { ok: true; value: unknown } | { ok: false; reason: string; error?: string };

interface SlateShareProbeRpc extends Rpc.DurableObjectBranded {
  start(): Promise<void>;
  share(): Promise<ProbeAnswer>;
  viewerFetch(handle: string, claim: { userId: string | null; source: string }): Promise<{ status: number; body: string }>;
  viewerBatch(handle: string, claim: { userId: string | null; source: string }): Promise<{ probe: string | null; mutateError: string }>;
  viewerSocket(handle: string, claim: { userId: string | null; source: string }): Promise<{ probe: string | null; mutateError: string }>;
  replay(share: string): Promise<ProbeAnswer>;
  requests(share: string): Promise<ProbeAnswer>;
  revoke(share: string): Promise<ProbeAnswer>;
  stopped(): Promise<boolean>;
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
      STEER_PROBE: DurableObjectNamespace<SteerProbeDO>;
      EVICTION_PROBE: DurableObjectNamespace<EvictionProbeDO>;
      WITNESS: DurableObjectNamespace<WitnessDO>;
      CAPPED_TURN_PROBE: DurableObjectNamespace<CappedTurnProbeDO>;
      UNBOUNDED_TURN_PROBE: DurableObjectNamespace<UnboundedTurnProbeDO>;
      SPEND_PROBE: DurableObjectNamespace<SpendProbeDO>;
      TERMINAL_EFFECT_PROBE: DurableObjectNamespace<TerminalEffectProbeDO>;
      DB_CAPABILITY_PROBE: DurableObjectNamespace<DbCapabilityProbeDO>;
      FIBER_RECOVERY_PROBE: DurableObjectNamespace<FiberRecoveryProbeAgent>;
      FORK_SOURCE: DurableObjectNamespace<ForkSourceProbeDO>;
      FORK_TARGET: DurableObjectNamespace<ForkTargetProbeDO>;
      STREAM_LIFECYCLE: DurableObjectNamespace<StreamLifecycleDO>;
      DEVICE_LEDGER_PROBE: DurableObjectNamespace<DeviceLedgerProbeDO>;
      FILES_EIO_PROBE: DurableObjectNamespace<FilesEioProbeDO>;
      PREVIEW_PORT_PROBE: DurableObjectNamespace<PreviewPortProbeDO>;
      SLATE_PROCESS_PROBE: DurableObjectNamespace<SlateProcessProbeRpc>;
      SLATE_SHARE_PROBE: DurableObjectNamespace<SlateShareProbeRpc>;
      SLATE_ACTOR_ROOT: DurableObjectNamespace<SlateActorRootRpc>;
      PLAN_ANNOUNCE_ROOT: DurableObjectNamespace<PlanAnnounceRpc>;
      TWO_TURN_PROBE: DurableObjectNamespace<TwoTurnProbeRpc>;
      HIRE_PROBE: DurableObjectNamespace<HireProbeRpc>;
      USER_SOCKET_PROBE: DurableObjectNamespace<UserSocketProbeRpc>;
      SLATE_DURABILITY_PROBE: DurableObjectNamespace<SlateDurabilityProbeRpc>;
      ACCOUNT_RESET_PROBE: DurableObjectNamespace<AccountResetProbeRpc>;
  // A devbox's readiness refusal must serialise over Workers RPC as data,
  // not as a thrown class name. The probe is a narrow DO exposing only the
  // two halves of `RestoreReadiness` plus the normalization control —
  // deliberately NOT a sandbox stub, so it says nothing about containers.
  DEVBOX_NOT_READY_PROBE: DurableObjectNamespace<DevboxNotReadyProbeDO>;
      /** The dynamic-Worker loader the eval sandbox runs in. */
      LOADER: WorkerLoader;
      /** The production Worker entry, hosted by `public-surface-probe`: the
       *  public route table as a peer of this runner, WebSocket upgrades
       *  included. */
      PUBLIC_SURFACE: Fetcher;
      /** That worker's one test-only entrypoint, for the shared model log. */
      SURFACE_CONTROL: Service<SurfaceControlRpc>;
    }

    /** The test worker re-exports the production egress entrypoint, so
     *  `exports.CodemodeEgress` is a loopback stub here as it is in production. */
    interface GlobalProps {
      mainModule: {
        SlateBinding: typeof SlateBinding;
        CodemodeEgress: typeof CodemodeEgress;
        SlateChainProbe: typeof SlateChainProbe;
      };
    }
  }
}
