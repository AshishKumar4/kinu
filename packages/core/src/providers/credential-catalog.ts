/**
 * A provider's live model list, read per credential. One policy for every remote catalog: a read that said nothing
 * (unreachable, refused, unreadable) is reported as a {@link StaleModelList}, never answered as a catalog with no models,
 * which would drop the account's choices unexplained and disqualify its configured model.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { diagnostics, renderThrownChain, settle } from '../obs/index';
import type { AuthResolution, ModelInfo } from './types';
import { cloneModelInfos, StaleModelList } from './util';

/** Why a live model list said nothing, which is no list of no models; `models` is what it read regardless. */
export interface CatalogUnread {
  readonly reason: string;
  readonly cause?: unknown;
  readonly models?: readonly ModelInfo[];
}

function authCacheKey(auth: AuthResolution): string {
  return JSON.stringify([auth.headers, auth.baseURL ?? null]);
}

/** A catalog route's answer read through `schema`, or why it said nothing: unreachable, `refused` by what answered, an
 *  error status, or a body this client cannot read. */
export function catalogBody<S extends v.GenericSchema>(
  host: string, schema: S, send: () => Promise<Response>, refused?: (res: Response) => string | null,
): Effect.Effect<v.InferOutput<S>, CatalogUnread> {
  return Effect.gen(function* () {
    const res = yield* Effect.tryPromise({ try: send, catch: (cause): CatalogUnread => ({ reason: `${host} could not be reached`, cause }) });
    const refusal = refused?.(res) ?? null;

    if (refusal !== null) return yield* Effect.fail({ reason: refusal });

    if (!res.ok) return yield* Effect.fail({ reason: `${host} answered HTTP ${String(res.status)}` });

    const text = yield* Effect.tryPromise({ try: () => res.text(), catch: (cause): CatalogUnread => ({ reason: `${host} could not be reached`, cause }) });
    const body = v.safeParse(v.pipe(v.string(), v.parseJson(), schema), text);

    if (!body.success) return yield* Effect.fail({ reason: `${host} answered a catalog this client cannot read`, cause: new v.ValiError(body.issues) });

    return body.output;
  });
}

/**
 * `label`'s list as `read` answers it per credential, kept `ttlMs`; no credential lists nothing. A read that says
 * nothing holds what it read, else this credential's last list.
 */
export function credentialCatalog(label: string, ttlMs: number) {
  const held = new Map<string, { readonly at: number; readonly models: readonly ModelInfo[] }>();

  return (auth: AuthResolution | null, read: (auth: AuthResolution) => Effect.Effect<readonly ModelInfo[], CatalogUnread>): Promise<ModelInfo[]> => {
    if (auth === null) return Promise.resolve([]);

    const key = authCacheKey(auth);
    const last = held.get(key);

    if (last !== undefined && Date.now() - last.at < ttlMs) return Promise.resolve(cloneModelInfos(last.models));

    return settle(read(auth).pipe(
      Effect.tap((models) => Effect.sync(() => { held.set(key, { at: Date.now(), models }); })),
      Effect.map((models) => cloneModelInfos(models)),
      Effect.catch((unread) => {
        diagnostics.event('models.catalog_unread', { provider: label, error: unread.cause === undefined ? unread.reason : renderThrownChain({ cause: unread.cause }) });

        return Effect.fail(new StaleModelList(cloneModelInfos(unread.models ?? last?.models), { reason: `${label} models could not be read: ${unread.reason}`, cause: unread.cause }));
      }),
    ));
  };
}
