/**
 * `/ops/tables`: the deploy's walk (`scripts/reset.ts tables`) opening the objects it names, by id or by name, so each
 * repairs itself under this build (core state/schema-repair.ts), and reading back what each holds and what its repair
 * did. `/ops/roots` names the accounts the walk starts from. Their bearer is a one-time pass the step itself wrote into
 * this deployment's AUTH_KV with wrangler, the authority a reset deletes with: who cannot write the deployment's own
 * store cannot pass, and no session is asked. The KV row holds the pass's digest, and lives hours.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { Effect } from 'effect';
import {
  err, EVAL_ACCOUNTS, json, OPS_OBJECTS_PER_REQUEST, OPS_PASS_PREFIX, opsCaller, safeJson, sha256Hex, type OpsCaller, type TablesAnswer,
} from '@kinu.run/core';
import { BUILTIN_ACCOUNTS_OBJECT, type SignInDeclarationEnv } from '@kinu.run/core/identity';
import { attempt, renderThrownChain, settle } from '@kinu.run/core/obs';
import type { FamilyEnv } from './api/context';
import { accountIdFor } from './auth/store';
import { evalAccountEmail } from './auth/session';
import { controlPlaneStub, hasControlPlane } from './control-plane/stub';
import type { ControlPlaneDO } from './control-plane/control-plane-do';

/** The classes the walk reaches, and the namespace each is bound as. */
const OPS_CLASSES = ['UserDO', 'OrchestratorAgent'] as const;

type OpsClass = (typeof OPS_CLASSES)[number];

const OpsRequestSchema = v.pipe(
  v.object({
    class: v.picklist(OPS_CLASSES),
    ids: v.optional(v.array(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u))), []),
    names: v.optional(v.array(v.pipe(v.string(), v.nonEmpty(), v.maxLength(512))), []),
  }),
  v.check((body) => body.ids.length + body.names.length <= OPS_OBJECTS_PER_REQUEST),
);

interface OpsObject {
  opsTables(caller: OpsCaller): Promise<TablesAnswer>;
}

interface OpsNamespace {
  idFromString(id: string): DurableObjectId;
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): OpsObject;
}

export interface OpsEnv extends SignInDeclarationEnv {
  /** Where the step wrote its pass: read by key alone. */
  AUTH_KV: { get(key: string): Promise<string | null> };
  CREDENTIAL_ENCRYPTION_KEY?: string;
  DEV_USER_EMAIL?: string;
  UserDO: OpsNamespace;
  OrchestratorAgent: OpsNamespace;
  ControlPlaneDO?: DurableObjectNamespace<ControlPlaneDO>;
}

/** An object as the walk named it: by its id, and by its name where it was reached by one. */
interface NamedObject {
  readonly id: string;
  readonly name?: string;
}

/** One object's answer, or why it gave none. */
type OpsAnswer = NamedObject & ({ readonly answer: TablesAnswer } | { readonly error: string });

/** `object` as its answer names it. */
function named(object: { readonly id: DurableObjectId; readonly name?: string }): NamedObject {
  return object.name === undefined ? { id: object.id.toString() } : { id: object.id.toString(), name: object.name };
}

export const opsRoutes = new Hono<FamilyEnv<OpsEnv, object>>();

/** Whether the request bears a pass the step wrote. */
function admitted(env: OpsEnv, header: string | undefined): Effect.Effect<boolean> {
  const pass = /^Bearer (\S{32,})$/u.exec(header ?? '')?.[1];

  return pass === undefined ? Effect.succeed(false) : Effect.map(Effect.promise(() => env.AUTH_KV.get(`${OPS_PASS_PREFIX}${sha256Hex(pass)}`)), (written) => written !== null);
}

const REFUSED = 'The deploy\'s walk is run by its deploy step, which writes its pass into this deployment first.';

/** The accounts the walk starts from, by the name each object is reached by: the builtin sign-in directory, every
 *  user the control plane has seen, and the eval service's own accounts. */
opsRoutes.post('/ops/roots', (c) => settle(Effect.gen(function* () {
  if (!(yield* admitted(c.env, c.req.header('authorization')))) return err(401, REFUSED);
  const caller = yield* Effect.promise(() => opsCaller(c.env));
  const { ControlPlaneDO } = c.env;

  const seen = ControlPlaneDO !== undefined && hasControlPlane({ ControlPlaneDO })
    ? yield* Effect.promise(() => controlPlaneStub({ ControlPlaneDO }).opsUsers(caller)) : [];

  const dev = c.env.DEV_USER_EMAIL ?? '';
  const evalEmails = dev === '' ? [] : [dev, ...EVAL_ACCOUNTS.map((account) => evalAccountEmail(dev, account))];
  const evals = yield* Effect.promise(() => Promise.all(evalEmails.map((email) => accountIdFor(c.env, email))));

  return json({ body: { accounts: [...new Set([BUILTIN_ACCOUNTS_OBJECT, ...evals, ...seen])] } });
})));

opsRoutes.post('/ops/tables', (c) => settle(Effect.gen(function* () {
  if (!(yield* admitted(c.env, c.req.header('authorization')))) return err(401, REFUSED);
  const body = yield* Effect.promise(() => safeJson(c.req.raw, OpsRequestSchema));

  if (body === null) return err(400, `The body names a class, and at most ${String(OPS_OBJECTS_PER_REQUEST)} objects by id or by name.`);
  const namespace: OpsNamespace = c.env[body.class satisfies OpsClass];
  const caller = yield* Effect.promise(() => opsCaller(c.env));

  const objects: Array<{ readonly id: DurableObjectId; readonly name?: string }> = [
    ...body.ids.map((id) => ({ id: namespace.idFromString(id) })),
    ...body.names.map((name) => ({ id: namespace.idFromName(name), name })),
  ];

  // An object that cannot answer is named with why, and the rest still answer: the step prints both.
  const answers = yield* Effect.forEach(objects, (object) => Effect.match(
    attempt({ doing: `reaching ${body.class} ${object.name ?? object.id.toString()}`, otherwise: 'unavailable' }, () => namespace.get(object.id).opsTables(caller)),
    {
      onSuccess: (answer): OpsAnswer => ({ ...named(object), answer }),
      onFailure: (failure): OpsAnswer => ({ ...named(object), error: renderThrownChain({ cause: failure }) }),
    },
  ), { concurrency: 10 });

  return json({ body: { objects: answers } });
})));

opsRoutes.all('/ops/*', async () => err(404, 'Not found'));
