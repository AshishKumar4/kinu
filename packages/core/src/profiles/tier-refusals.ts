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
  readonly config: Pick<AgentConfigStore, 'get' | 'set' | 'delete' | 'all'>;
  readonly now: () => number;
  readonly settings: string;
}): TierRefusals {
  return {
    refused: ({ tier, model, cause }) => {
      const status = providerStatusOf({ cause });
      const said = JSON.stringify({ model, status: status ?? null });

      if (deps.config.get(`${REFUSAL_KEY}${tier}`) === said) return;
      deps.config.set(`${REFUSAL_KEY}${tier}`, said);
      diagnostics.event('profile.tier_refused', { tier, model, status: status ?? 0 });
      writeActivityLog(() => ({ sql: deps.sql, actor: deps.actor }), {
        event: 'model_tier_refused',
        detail: `Your ${tier} tier, ${model}, is refusing requests: ${describeProviderError({ cause })}. Change it in ${deps.settings}.`,
        elapsedMs: 0,
        createdAt: deps.now(),
      });
    },
    answered: (tier) => {
      if (deps.config.get(`${REFUSAL_KEY}${tier}`) !== null) deps.config.delete(`${REFUSAL_KEY}${tier}`);
    },
    forget: () => {
      for (const key of Object.keys(deps.config.all())) if (key.startsWith(REFUSAL_KEY)) deps.config.delete(key);
    },
  };
}
