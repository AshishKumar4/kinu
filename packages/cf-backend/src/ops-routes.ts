/**
 * `/ops/restore`: the operator's restore of one workspace or account to a point in time (`scripts/restore.ts`,
 * ARCHITECTURE-DECISIONS W7), behind the same pass.
 *
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
  err, EVAL_ACCOUNTS, evalAccountEmail, json, OPS_OBJECTS_PER_REQUEST, OPS_PASS_PREFIX, opsCaller, restoreLanded, RestoreTargetSchema, safeJson, sha256Hex,
  type ArmedRestore, type OpsCaller, type RestoreTarget, type TablesAnswer,
} from '@kinu.run/core';
import { BUILTIN_ACCOUNTS_OBJECT, type SignInDeclarationEnv } from '@kinu.run/core/identity';
import { attempt, diagnostics, renderThrownChain, settle } from '@kinu.run/core/obs';
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

/** An object a restore reaches: its storage's history, and its activation's end. */
interface RestorableObject extends OpsObject {
  opsRestore(caller: OpsCaller, target: RestoreTarget): Promise<ArmedRestore>;
  opsRestart(caller: OpsCaller): Promise<void>;
  opsBookmark(caller: OpsCaller): Promise<string>;
}

interface OpsNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): OpsObject;
}

/** A namespace whose objects a restore reaches. */
interface RestorableNamespace extends OpsNamespace {
  get(id: DurableObjectId): RestorableObject;
}

/** One workspace by its name, or one account by its id or email; and the moment or bookmark it goes back to. */
const RestoreRequestSchema = v.strictObject({
  object: v.union([
    v.strictObject({ class: v.picklist(['OrchestratorAgent', 'UserDO']), name: v.pipe(v.string(), v.nonEmpty(), v.maxLength(512)) }),
    v.strictObject({ class: v.literal('UserDO'), email: v.pipe(v.string(), v.email()) }),
  ]),
  to: RestoreTargetSchema,
});

export interface OpsEnv extends SignInDeclarationEnv {
  /** Where the step wrote its pass: read by key alone. */
  AUTH_KV: { get(key: string): Promise<string | null> };
  CREDENTIAL_ENCRYPTION_KEY?: string;
  DEV_USER_EMAIL?: string;
  UserDO: RestorableNamespace;
  OrchestratorAgent: RestorableNamespace;
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

/**
 * Arms the restore, ends the object so it lands, then reads its history from a fresh start: the restore landed when
 * the object stands past the undo bookmark. One that did not land is still armed and would land at the next eviction,
 * so it is said loudly, with the bookmark that takes it back.
 */
opsRoutes.post('/ops/restore', (c) => settle(Effect.gen(function* () {
  if (!(yield* admitted(c.env, c.req.header('authorization')))) return err(401, REFUSED);
  const body = yield* Effect.promise(() => safeJson(c.req.raw, RestoreRequestSchema));

  if (body === null) return err(400, 'The body names one workspace or account and the moment ({ at }) or bookmark it goes back to.');
  const caller = yield* Effect.promise(() => opsCaller(c.env));
  const { object } = body;
  const name = 'email' in object ? yield* Effect.promise(() => accountIdFor(c.env, object.email)) : object.name;
  const namespace = object.class === 'UserDO' ? c.env.UserDO : c.env.OrchestratorAgent;
  const id = namespace.idFromName(name);
  const armed = yield* attempt({ doing: `arming ${object.class} ${name}'s restore`, otherwise: 'unavailable' }, () => namespace.get(id).opsRestore(caller, body.to));
  const said = { class: object.class, name, id: id.toString(), ...armed };

  diagnostics.event('ops.restore_armed', said);

  // The rejection of this call is the restart's receipt.
  const ended = yield* Effect.exit(attempt({ doing: 'restarting it', otherwise: 'unavailable' }, () => namespace.get(id).opsRestart(caller)));
  const current = yield* attempt({ doing: 'reading its history after the restart', otherwise: 'unavailable' }, () => namespace.get(id).opsBookmark(caller));
  const landed = restoreLanded(current, armed.undo);

  diagnostics.event('ops.restore_answered', { ...said, current, landed, restart: ended._tag });

  return json({ body: { ...said, current, landed } }, { status: landed ? 200 : 502 });
})));

opsRoutes.all('/ops/*', async () => err(404, 'Not found'));
