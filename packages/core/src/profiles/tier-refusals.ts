/** A tier refusing for the owner to fix is said once (T3). */
import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from '../identity/actor-handle';
import { writeActivityLog } from '../identity/activity-log';
import { diagnostics } from '../obs/index';
import { describeProviderError, providerStatusOf } from '../providers/util';
import type { TierId } from '../types/profile';
import type { SqlExecutor } from '../types/primitives';

export interface TierRefusal {
  readonly model: string;
  readonly cause: unknown;
}

export interface TierRefusals {
  changes(): number;
  refused(refusal: { readonly tier: TierId; readonly since: number; readonly refusals: readonly TierRefusal[] }): void;
  answered(tier: TierId): void;
}

const REFUSAL_KEY = 'model_refusal:';

export function tierRefusals(deps: {
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  readonly config: Pick<AgentConfigStore, 'set' | 'delete' | 'all'>;
  readonly now: () => number;
  readonly settings: string;
  readonly changes: () => number;
}): TierRefusals {
  let said: Map<string, string> | null = null;
  let synced = 0;

  const saidSoFar = (): Map<string, string> => {
    said ??= new Map(Object.entries(deps.config.all()).filter(([key]) => key.startsWith(REFUSAL_KEY)));

    return said;
  };

  return {
    changes: () => deps.changes(),
    refused: ({ tier, since, refusals }) => {
      const changes = deps.changes();

      if (since !== changes) return;

      if (synced !== changes) {
        for (const key of saidSoFar().keys()) deps.config.delete(key);
        saidSoFar().clear();
        synced = changes;
      }

      const named = refusals.map(({ model, cause }) => ({ model, status: providerStatusOf({ cause }) ?? null }));
      const text = JSON.stringify(named);

      if (saidSoFar().get(`${REFUSAL_KEY}${tier}`) === text) return;
      deps.config.set(`${REFUSAL_KEY}${tier}`, text);
      saidSoFar().set(`${REFUSAL_KEY}${tier}`, text);
      diagnostics.event('profile.tier_refused', {
        tier, models: named.map(({ model }) => model).join(', '), statuses: named.map(({ status }) => String(status ?? 0)).join(', '),
      });
      writeActivityLog(() => ({ sql: deps.sql, actor: deps.actor }), {
        event: 'model_tier_refused',
        detail: `Your ${tier} tier is refusing requests. ${refusals.map(({ model, cause }) => `${model}: ${describeProviderError({ cause })}.`).join(' ')} `
          + `Change it in ${deps.settings}.`,
        elapsedMs: 0,
        createdAt: deps.now(),
      });
    },
    answered: (tier) => {
      if (!saidSoFar().delete(`${REFUSAL_KEY}${tier}`)) return;
      deps.config.delete(`${REFUSAL_KEY}${tier}`);
    },
  };
}
