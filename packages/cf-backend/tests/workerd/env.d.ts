// Bindings of the workerd test worker. Deliberately separate from
// ../../env.d.ts, which declares the PRODUCTION `Env` and is compiled by
// packages/cf-backend/tsconfig.json — this directory is its own tsc project
// (see ./tsconfig.json) precisely so the two binding surfaces cannot drift into
// each other. `cloudflare:test` and `cloudflare:workers` both read
// `Cloudflare.Env`, which is why the augmentation targets that namespace and
// not the bare global `Env`.
import type {
  AlarmDO, GatedDO, NeighbourDO, RetentionDO, SocketDO, SteerProbeDO, TransactionDO,
} from './worker';
import type { EvictionProbeDO, WitnessDO } from './eviction-probe';
import type { CappedTurnProbeDO, UnboundedTurnProbeDO } from './step-cap-probe';
import type { SpendProbeDO } from './spend-probe';

declare global {
  namespace Cloudflare {
    interface Env {
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
    }
  }
}
