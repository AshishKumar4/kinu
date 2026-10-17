/**
 * `/ops/tables`: the deploy's walk (`scripts/reset.ts tables`) opening the objects it names, by name alone, so each
 * repairs itself under this build (core state/schema-repair.ts), and reading back what each holds and what its repair
 * did. `/ops/roots` names the accounts the walk starts from. Their bearer is a one-time pass the step itself wrote into
 * this deployment's AUTH_KV with wrangler, the authority a reset deletes with: who cannot write the deployment's own
 * store cannot pass, and no session is asked. The KV row holds the pass's digest, and lives hours.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import { Effect } from 'effect';
import {
  err, EVAL_ACCOUNTS, evalAccountEmail, json, OPS_OBJECTS_PER_REQUEST, OPS_PASS_PREFIX, opsCaller, safeJson, sha256Hex, type OpsCaller, type TablesAnswer,
} from '@kinu.run/core';
import { BUILTIN_ACCOUNTS_OBJECT, type SignInDeclarationEnv } from '@kinu.run/core/identity';
import { attempt, renderThrownChain, settle } from '@kinu.run/core/obs';
import type { FamilyEnv } from './api/context';
import { accountIdFor } from './auth/store';
import { CONTROL_PLANE_SINGLETON, controlPlaneStub, hasControlPlane } from './control-plane/stub';

/** The classes the walk reaches. */
const OPS_CLASSES = ['UserDO', 'OrchestratorAgent', 'ControlPlaneDO'] as const;

type OpsClass = (typeof OPS_CLASSES)[number];

// By name alone: a workspace opened by an id it never recorded a name under refuses to construct, so a walk that
// opened objects by id threw in each one never named (staging rc12, 2026-10-16).
const OpsRequestSchema = v.strictObject({
  class: v.picklist(OPS_CLASSES),
  names: v.pipe(v.array(v.pipe(v.string(), v.nonEmpty(), v.maxLength(512))), v.maxLength(OPS_OBJECTS_PER_REQUEST)),
});

interface OpsObject {
  opsTables(caller: OpsCaller): Promise<TablesAnswer>;
}

interface OpsNamespace {
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
  ControlPlaneDO?: { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): OpsControlPlane };
}

/** The control plane as the walk reaches it: its users, the accounts the walk starts from, and its own tables. */
interface OpsControlPlane extends OpsObject {
  opsUsers(caller: OpsCaller): Promise<string[]>;
}

/** An object as the walk named it, and the id its name makes, which Cloudflare's list is read against. */
interface NamedObject {
  readonly id: string;
  readonly name: string;
}

/** One object's answer, or why it gave none. */
type OpsAnswer = NamedObject & ({ readonly answer: TablesAnswer } | { readonly error: string });

/** `object` as its answer names it. */
function named(object: { readonly id: DurableObjectId; readonly name: string }): NamedObject {
  return { id: object.id.toString(), name: object.name };
}

export const opsRoutes = new Hono<FamilyEnv<OpsEnv, object>>();

/** The namespace a class is bound as, where it is bound. */
function namespaceOf(env: OpsEnv, className: OpsClass): OpsNamespace | undefined {
  return className === 'ControlPlaneDO' ? env.ControlPlaneDO : env[className];
}

/** Whether the request bears a pass the step wrote. */
function admitted(env: OpsEnv, header: string | undefined): Effect.Effect<boolean> {
  const pass = /^Bearer (\S{32,})$/u.exec(header ?? '')?.[1];

  return pass === undefined ? Effect.succeed(false) : Effect.map(Effect.promise(() => env.AUTH_KV.get(`${OPS_PASS_PREFIX}${sha256Hex(pass)}`)), (written) => written !== null);
}

const REFUSED = 'The deploy\'s walk is run by its deploy step, which writes its pass into this deployment first.';

/** The objects the walk starts from, by the name each is reached by: the accounts (the builtin sign-in directory,
 *  every user the control plane has seen, and the eval service's own) and the control plane itself, where one is
 *  bound. */
opsRoutes.post('/ops/roots', (c) => settle(Effect.gen(function* () {
  if (!(yield* admitted(c.env, c.req.header('authorization')))) return err(401, REFUSED);
  const caller = yield* Effect.promise(() => opsCaller(c.env));
  const { ControlPlaneDO } = c.env;

  const bound = ControlPlaneDO !== undefined && hasControlPlane({ ControlPlaneDO });
  const seen = bound ? yield* Effect.promise(() => controlPlaneStub({ ControlPlaneDO }).opsUsers(caller)) : [];

  const dev = c.env.DEV_USER_EMAIL ?? '';
  const evalEmails = dev === '' ? [] : [dev, ...EVAL_ACCOUNTS.map((account) => evalAccountEmail(dev, account))];
  const evals = yield* Effect.promise(() => Promise.all(evalEmails.map((email) => accountIdFor(c.env, email))));

  return json({ body: { accounts: [...new Set([BUILTIN_ACCOUNTS_OBJECT, ...evals, ...seen])], control: bound ? [CONTROL_PLANE_SINGLETON] : [] } });
})));

opsRoutes.post('/ops/tables', (c) => settle(Effect.gen(function* () {
  if (!(yield* admitted(c.env, c.req.header('authorization')))) return err(401, REFUSED);
  const body = yield* Effect.promise(() => safeJson(c.req.raw, OpsRequestSchema));

  if (body === null) return err(400, `The body names a class, and at most ${String(OPS_OBJECTS_PER_REQUEST)} objects by name.`);
  const namespace = namespaceOf(c.env, body.class);

  if (namespace === undefined) return err(400, `This deployment binds no ${body.class}.`);
  const caller = yield* Effect.promise(() => opsCaller(c.env));

  const objects = body.names.map((name) => ({ id: namespace.idFromName(name), name }));

  // An object that cannot answer is named with why, and the rest still answer: the step prints both.
  const answers = yield* Effect.forEach(objects, (object) => Effect.match(
    attempt({ doing: `reaching ${body.class} ${object.name}`, otherwise: 'unavailable' }, () => namespace.get(object.id).opsTables(caller)),
    {
      onSuccess: (answer): OpsAnswer => ({ ...named(object), answer }),
      onFailure: (failure): OpsAnswer => ({ ...named(object), error: renderThrownChain({ cause: failure }) }),
    },
  ), { concurrency: 10 });

  return json({ body: { objects: answers } });
})));

opsRoutes.all('/ops/*', async () => err(404, 'Not found'));
