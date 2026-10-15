/**
 * `/ops/tables`: a release's tables reset (`scripts/reset.ts tables`) reaching the objects the deployer names, each by
 * its id. Its bearer is a one-time pass the step itself wrote into this deployment's AUTH_KV with wrangler, the
 * authority a reset deletes with: who cannot write the deployment's own store cannot pass, and no session is asked.
 * The KV row holds the pass's digest, and lives minutes.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { Effect } from 'effect';
import { err, json, OPS_OBJECTS_PER_REQUEST, OPS_PASS_PREFIX, opsCaller, safeJson, sha256Hex, TablesRequestSchema, type OpsCaller, type TablesAnswer, type TablesRequest } from '@kinu.run/core';
import { attempt, renderThrownChain, settle } from '@kinu.run/core/obs';
import type { FamilyEnv } from './api/context';

/** The classes a tables reset reaches, and the namespace each is bound as. */
const OPS_CLASSES = ['UserDO', 'OrchestratorAgent'] as const;

type OpsClass = (typeof OPS_CLASSES)[number];

const OpsRequestSchema = v.object({
  class: v.picklist(OPS_CLASSES),
  ids: v.pipe(v.array(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u))), v.maxLength(OPS_OBJECTS_PER_REQUEST)),
  request: TablesRequestSchema,
});

interface OpsObject {
  opsTables(caller: OpsCaller, request: TablesRequest): Promise<TablesAnswer>;
}

interface OpsNamespace {
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): OpsObject;
}

export interface OpsEnv {
  /** Where the step wrote its pass: read by key alone. */
  AUTH_KV: { get(key: string): Promise<string | null> };
  CREDENTIAL_ENCRYPTION_KEY?: string;
  UserDO: OpsNamespace;
  OrchestratorAgent: OpsNamespace;
}

/** One object's answer, or why it gave none. */
type OpsAnswer = { readonly id: string } & ({ readonly answer: TablesAnswer } | { readonly error: string });

export const opsRoutes = new Hono<FamilyEnv<OpsEnv, object>>();

opsRoutes.post('/ops/tables', (c) => settle(Effect.gen(function* () {
  const pass = /^Bearer (\S{32,})$/u.exec(c.req.header('authorization') ?? '')?.[1];
  const written = pass === undefined ? null : yield* Effect.promise(() => c.env.AUTH_KV.get(`${OPS_PASS_PREFIX}${sha256Hex(pass)}`));

  if (written === null) return err(401, 'A tables reset is run by its deploy step, which writes its pass into this deployment first.');
  const body = yield* Effect.promise(() => safeJson(c.req.raw, OpsRequestSchema));

  if (body === null) return err(400, 'The body names a class, at most 50 object ids, and the tables.');
  const namespace: OpsNamespace = c.env[body.class satisfies OpsClass];
  const caller = yield* Effect.promise(() => opsCaller(c.env));

  // An object that cannot answer is named with why, and the rest still answer: the step prints both.
  const objects = yield* Effect.forEach(body.ids, (id) => Effect.match(
    attempt({ doing: `reaching ${body.class} ${id}`, otherwise: 'unavailable' }, () => namespace.get(namespace.idFromString(id)).opsTables(caller, body.request)),
    { onSuccess: (answer): OpsAnswer => ({ id, answer }), onFailure: (failure): OpsAnswer => ({ id, error: renderThrownChain({ cause: failure }) }) },
  ), { concurrency: 10 });

  return json({ body: { objects } });
})));

opsRoutes.all('/ops/*', async () => err(404, 'Not found'));
