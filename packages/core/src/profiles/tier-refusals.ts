/** A tier, or the decision model that rates turns, refusing for the owner to fix is said once (T3). */
import * as v from 'valibot';
import type { AgentConfigStore } from '../config/store';
import type { ActorHandle } from '../identity/actor-handle';
import { writeActivityLog } from '../identity/activity-log';
import { diagnostics } from '../obs/index';
import { describeProviderError, providerStatusOf } from '../providers/util';
import type { TierRefusals } from '../types/refusals';
import { DECISION_REFUSALS } from '../providers/decision-model';
import type { SqlExecutor } from '../types/primitives';


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
        detail: `Your ${tier === DECISION_REFUSALS ? 'decision model' : `${tier} tier`} is refusing requests. ${refusals.map(({ model, cause }) => `${model}: ${describeProviderError({ cause })}.`).join(' ')} `
          + `Change it in ${deps.settings}.`,
        elapsedMs: 0,
        createdAt: deps.now(),
      });
    },
    answered: (tier) => {
      if (!saidSoFar().delete(`${REFUSAL_KEY}${tier}`)) return;
      deps.config.delete(`${REFUSAL_KEY}${tier}`);
    },
    untrusted: (asked) => {
      const text = asked === null ? null : JSON.stringify(asked);

      if ((saidSoFar().get(UNTRUSTED_KEY) ?? null) === text) return;

      if (text === null) {
        saidSoFar().delete(UNTRUSTED_KEY);
        deps.config.delete(UNTRUSTED_KEY);

        return;
      }

      saidSoFar().set(UNTRUSTED_KEY, text);
      deps.config.set(UNTRUSTED_KEY, text);
    },
  };
}

/** Where `untrusted` keeps the fast-tier model no rating could be asked of, beside the refusals said once (so a change of
 *  model settings clears it too). Spaced, as `DECISION_REFUSALS` is, so no tier's id can name it. */
const UNTRUSTED_KEY = `${REFUSAL_KEY}untrusted rating`;

/**
 * Why the decision model rates no turn, so no dream opens, in the owner's words; null while turns can be rated. Read
 * from what `refused` and `untrusted` kept: Clef refusing (its notice in the activity log says why, and what fixes it),
 * and the fast tier's model not trusted to rate a turn in its place.
 */
export function unratedReason(config: Pick<AgentConfigStore, 'get'>, settings: string): string | null {
  const untrusted = v.safeParse(v.pipe(v.string(), v.parseJson(), v.object({ model: v.string(), questions: v.array(v.string()) })), config.get(UNTRUSTED_KEY));

  if (!untrusted.success || config.get(`${REFUSAL_KEY}${DECISION_REFUSALS}`) === null) return null;

  return `No turn is being rated, so no dream opens: Clef, the decision model, is refusing requests (its notice in Activity says why), `
    + `and ${untrusted.output.model} on your fast tier is not measured close enough to Clef to rate a turn in its place. Clef's access is set in ${settings}.`;
}
