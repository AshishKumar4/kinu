/** A tier refusing for the owner to fix is said once (T3). */
import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from '../identity/actor-handle';
import { writeActivityLog } from '../identity/activity-log';
import { diagnostics } from '../obs/index';
import { describeProviderError, providerStatusOf } from '../providers/util';
import type { TierId } from '../types/profile';
import type { SqlExecutor } from '../types/primitives';

export interface TierRefusals {
  refused(refusal: { readonly tier: TierId; readonly model: string; readonly cause: unknown }): void;
  answered(tier: TierId): void;
  forget(): void;
}

const REFUSAL_KEY = 'model_refusal:';

export function tierRefusals(deps: {
  readonly sql: SqlExecutor;
  readonly actor: ActorHandle;
  readonly config: Pick<AgentConfigStore, 'set' | 'delete' | 'all'>;
  readonly now: () => number;
  readonly settings: string;
}): TierRefusals {
  let said: Map<string, string> | null = null;

  const saidSoFar = (): Map<string, string> => {
    said ??= new Map(Object.entries(deps.config.all()).filter(([key]) => key.startsWith(REFUSAL_KEY)));

    return said;
  };

  return {
    refused: ({ tier, model, cause }) => {
      const status = providerStatusOf({ cause });
      const text = JSON.stringify({ model, status: status ?? null });

      if (saidSoFar().get(`${REFUSAL_KEY}${tier}`) === text) return;
      deps.config.set(`${REFUSAL_KEY}${tier}`, text);
      saidSoFar().set(`${REFUSAL_KEY}${tier}`, text);
      diagnostics.event('profile.tier_refused', { tier, model, status: status ?? 0 });
      writeActivityLog(() => ({ sql: deps.sql, actor: deps.actor }), {
        event: 'model_tier_refused',
        detail: `Your ${tier} tier, ${model}, is refusing requests: ${describeProviderError({ cause })}. Change it in ${deps.settings}.`,
        elapsedMs: 0,
        createdAt: deps.now(),
      });
    },
    answered: (tier) => {
      if (!saidSoFar().delete(`${REFUSAL_KEY}${tier}`)) return;
      deps.config.delete(`${REFUSAL_KEY}${tier}`);
    },
    forget: () => {
      for (const key of saidSoFar().keys()) deps.config.delete(key);
      saidSoFar().clear();
    },
  };
}
