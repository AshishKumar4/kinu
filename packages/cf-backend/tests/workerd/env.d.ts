// Bindings of the workerd test worker. Deliberately separate from
// ../../env.d.ts, which declares the PRODUCTION `Env` and is compiled by
// packages/cf-backend/tsconfig.json — this directory is its own tsc project
// (see ./tsconfig.json) precisely so the two binding surfaces cannot drift into
// each other. `cloudflare:test` and `cloudflare:workers` both read
// `Cloudflare.Env`, which is why the augmentation targets that namespace and
// not the bare global `Env`.
import type {
  AlarmDO, GatedDO, NeighbourDO, RetentionDO, SocketDO, SteerProbeDO, StreamLifecycleDO, TransactionDO,
} from './worker';
import type { EvictionProbeDO, WitnessDO } from './eviction-probe';
import type { CappedTurnProbeDO, UnboundedTurnProbeDO } from './step-cap-probe';
import type { SpendProbeDO } from './spend-probe';
import type { TerminalEffectProbeDO } from './terminal-effect-probe';
import type { DbCapabilityProbeDO } from './db-capability-probe';
import type { FiberRecoveryProbeAgent } from './agent-fiber-recovery-probe';
import type { ForkSourceProbeDO, ForkTargetProbeDO } from './fork-probe';
import type { SendAdmissionProbeDO } from './send-admission-probe';
import type { DeviceLedgerProbeDO } from './device-inflight-probe';
import type { FilesEioProbeDO } from './files-eio-probe';
import type { PreviewPortProbeDO } from './preview-port-probe';
import type { SlateProcessProbeDO, SlateChainProbe } from './slate-process-probe';
import type { CodemodeEgress } from '../../src/codemode-egress';
import type { SlateBinding } from '../../src/slates/bindings';
import type { ExecutorInfo } from '@kinu.run/core';
interface SlateActorRootRpc extends Rpc.DurableObjectBranded {
  exercise(family: 'subordinate' | 'exploration'): Promise<{ answer: ExecutorInfo[]; browserCallable: boolean }>;
  code(mode: 'plan' | 'build', code: string): Promise<{ answer: string; file: string }>;
}
interface PlanAnnounceRpc extends Rpc.DurableObjectBranded {
  exercise(): Promise<{
    hops: Record<string, { ok: boolean; error: string | null }>;
    published: string[];
  }>;
}
interface UserSocketProbeRpc extends Rpc.DurableObjectBranded {
  deliverBareFrame(): Promise<'handled' | { readonly threw: string }>;
}
interface SlateEgressRpc extends Rpc.DurableObjectBranded {
  request(mode: 'plan' | 'build', target: string, redirect?: RequestRedirect): Promise<string>;
  publicPlanCall(): Promise<{ ok: boolean; reason?: string }>;
  unmediatedThenMediated(): Promise<{ unmediated: string; mediated: string; reused: string }>;
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
      SEND_ADMISSION_PROBE: DurableObjectNamespace<SendAdmissionProbeDO>;
      DEVICE_LEDGER_PROBE: DurableObjectNamespace<DeviceLedgerProbeDO>;
      FILES_EIO_PROBE: DurableObjectNamespace<FilesEioProbeDO>;
      PREVIEW_PORT_PROBE: DurableObjectNamespace<PreviewPortProbeDO>;
      SLATE_PROCESS_PROBE: DurableObjectNamespace<SlateProcessProbeDO>;
      SLATE_ACTOR_ROOT: DurableObjectNamespace<SlateActorRootRpc>;
      PLAN_ANNOUNCE_ROOT: DurableObjectNamespace<PlanAnnounceRpc>;
      USER_SOCKET_PROBE: DurableObjectNamespace<UserSocketProbeRpc>;
      /** The dynamic-Worker loader the execute_tools sandbox runs in. */
      LOADER: WorkerLoader;
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
