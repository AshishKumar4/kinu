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
  type ArmedRestore, type MissingBytes, type OpsCaller, type RestoreTarget, type TablesAnswer,
} from '@kinu.run/core';
import { BUILTIN_ACCOUNTS_OBJECT, type SignInDeclarationEnv } from '@kinu.run/core/identity';
import { attempt, diagnostics, KinuError, renderThrownChain, settle } from '@kinu.run/core/obs';
import type { FamilyEnv } from './api/context';
import { accountIdFor } from './auth/store';
import { CONTROL_PLANE_SINGLETON, controlPlaneStub, hasControlPlane } from './control-plane/stub';
import { tenantObjectNames } from './drive/tenant';

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
interface Restorable {
  opsRestore(caller: OpsCaller, target: RestoreTarget): Promise<ArmedRestore>;
  opsRestart(caller: OpsCaller): Promise<void>;
  opsBookmark(caller: OpsCaller): Promise<string>;
}

/** One whose rows name R2 bytes: which of them are gone. */
interface NamesBytes {
  opsMissing(caller: OpsCaller): Promise<MissingBytes>;
}

interface RestorableObject extends OpsObject, Restorable {}

/** A namespace of objects a restore reaches, by name. */
interface Named<Stub> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): Stub;
}

interface OpsNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): OpsObject;
}

/** A namespace whose objects a restore reaches. */
interface RestorableNamespace extends OpsNamespace {
  get(id: DurableObjectId): RestorableObject & Partial<NamesBytes>;
}

/** One workspace by its name, or one account by its id or email; and the moment or bookmark it goes back to. */
const ObjectNameSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(512));

/** The classes a restore reaches, and the names an undo restores each to its own bookmark by. */
const RESTORED_CLASSES = ['OrchestratorAgent', 'UserDO', 'MailboxDO', 'MossaicUserDO', 'MossaicShardDO'] as const;

const RestoreRequestSchema = v.union([
  v.strictObject({
    object: v.union([
      v.strictObject({ class: v.picklist(['OrchestratorAgent', 'UserDO']), name: ObjectNameSchema }),
      v.strictObject({ class: v.literal('UserDO'), email: v.pipe(v.string(), v.email()) }),
    ]),
    to: RestoreTargetSchema,
  }),
  // An undo: each object a restore named, back to the bookmark just before it (`scripts/restore.ts --undo`).
  v.strictObject({
    undo: v.pipe(v.array(v.strictObject({ class: v.picklist(RESTORED_CLASSES), name: ObjectNameSchema, bookmark: v.string() })), v.minLength(1), v.maxLength(512)),
  }),
]);

export interface OpsEnv extends SignInDeclarationEnv {
  /** Where the step wrote its pass: read by key alone. */
  AUTH_KV: { get(key: string): Promise<string | null> };
  CREDENTIAL_ENCRYPTION_KEY?: string;
  DEV_USER_EMAIL?: string;
  UserDO: RestorableNamespace;
  OrchestratorAgent: RestorableNamespace;
  MAILBOX?: Named<Restorable & NamesBytes>;
  MOSSAIC_USER?: Named<Restorable & { tenantShards(): Promise<number> }>;
  MOSSAIC_SHARD?: Named<Restorable>;
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

/** One object's restore, as the answer says it. */
interface ObjectRestored {
  readonly class: string;
  readonly name: string;
  readonly id: string;
  readonly bookmark: string;
  readonly undo: string;
  readonly previous: string;
  readonly current: string;
  readonly landed: boolean;
  /** What its rows name that R2 no longer holds, where its rows name any. */
  readonly missing?: MissingBytes;
}

/**
 * Arms one object's restore, ends it so it lands, then reads its history from a fresh start: it landed when the object
 * stands past the undo bookmark. One that did not land is still armed and would land at the next eviction.
 */
function restoredOne(
  { objectClass, name, namespace }: { readonly objectClass: string; readonly name: string; readonly namespace: Named<Restorable & Partial<NamesBytes>> },
  caller: OpsCaller, to: RestoreTarget,
): Effect.Effect<ObjectRestored, KinuError> {
  return Effect.gen(function* () {
    const id = namespace.idFromName(name);
    const armed = yield* attempt({ doing: `arming ${objectClass} ${name}'s restore`, otherwise: 'unavailable' }, () => namespace.get(id).opsRestore(caller, to));
    const said = { class: objectClass, name, id: id.toString(), ...armed };

    diagnostics.event('ops.restore_armed', said);

    // The rejection of this call is the restart's receipt.
    const ended = yield* Effect.exit(attempt({ doing: 'restarting it', otherwise: 'unavailable' }, () => namespace.get(id).opsRestart(caller)));
    const current = yield* attempt({ doing: 'reading its history after the restart', otherwise: 'unavailable' }, () => namespace.get(id).opsBookmark(caller));
    const landed = restoreLanded(current, armed.undo);
    const missingOf = namespace.get(id).opsMissing;

    const missing = landed && missingOf !== undefined
      ? yield* attempt({ doing: 'reading which of its bytes are gone', otherwise: 'unavailable' }, () => missingOf(caller))
      : undefined;

    diagnostics.event('ops.restore_answered', { ...said, current, landed, restart: ended._tag, missing: missing?.missing ?? 0 });

    return { ...said, current, landed, ...(missing !== undefined && { missing }) };
  });
}

/**
 * An account's objects, each to the same moment: the account, its mailbox, then its Drive's user object before each
 * shard, so no shard's sweep sees a reference the restored tenant names as gone. A bookmark is one object's, so an
 * account goes back by moment, never by bookmark.
 */
function accountRestored(env: OpsEnv, name: string, caller: OpsCaller, to: RestoreTarget): Effect.Effect<ObjectRestored[], KinuError> {
  return Effect.gen(function* () {
    const done = [yield* restoredOne({ objectClass: 'UserDO', name, namespace: env.UserDO }, caller, to)];

    if (env.MAILBOX !== undefined) done.push(yield* restoredOne({ objectClass: 'MailboxDO', name, namespace: env.MAILBOX }, caller, to));
    const { MOSSAIC_USER: users, MOSSAIC_SHARD: shards } = env;

    if (users === undefined || shards === undefined) return done;
    const names = tenantObjectNames(name);

    done.push(yield* restoredOne({ objectClass: 'MossaicUserDO', name: names.user, namespace: users }, caller, to));
    const spans = yield* attempt({ doing: "reading how many shards the Drive spans", otherwise: 'unavailable' }, () => users.get(users.idFromName(names.user)).tenantShards());

    for (let index = 0; index < spans; index += 1) done.push(yield* restoredOne({ objectClass: 'MossaicShardDO', name: names.shard(index), namespace: shards }, caller, to));

    return done;
  });
}

/** A workspace or an account restored to a moment, or an earlier restore undone. */
opsRoutes.post('/ops/restore', (c) => settle(Effect.gen(function* () {
  if (!(yield* admitted(c.env, c.req.header('authorization')))) return err(401, REFUSED);
  const body = yield* Effect.promise(() => safeJson(c.req.raw, RestoreRequestSchema));

  if (body === null) return err(400, 'The body names one workspace or account and the moment ({ at }) or bookmark it goes back to.');
  const caller = yield* Effect.promise(() => opsCaller(c.env));

  if ('undo' in body) return answered(yield* undone(c.env, body.undo, caller));
  const { object, to } = body;
  const name = 'email' in object ? yield* Effect.promise(() => accountIdFor(c.env, object.email)) : object.name;

  if (object.class === 'UserDO' && 'bookmark' in to) return err(400, 'An account goes back by a moment ({ at }): a bookmark names one object\'s history, and an account is several.');

  const restored = object.class === 'UserDO'
    ? yield* accountRestored(c.env, name, caller, to)
    : [yield* restoredOne({ objectClass: 'OrchestratorAgent', name, namespace: c.env.OrchestratorAgent }, caller, to)];

  return answered(restored);
})));

/** The objects a restore named and what each answered: all landed is 200, any still armed 502. */
function answered(restored: readonly ObjectRestored[]): Response {
  const landed = restored.every((one) => one.landed);

  return json({ body: { objects: restored, landed } }, { status: landed ? 200 : 502 });
}

/** Each object back to its own bookmark, in the order the restore took them. */
function undone(env: OpsEnv, objects: readonly { readonly class: (typeof RESTORED_CLASSES)[number]; readonly name: string; readonly bookmark: string }[], caller: OpsCaller) {
  return Effect.gen(function* () {
    const done: ObjectRestored[] = [];

    for (const object of objects) {
      const namespace = restoredNamespace(env, object.class);

      if (namespace === undefined) return yield* new KinuError('bad_input', `this deployment binds no ${object.class}`);
      done.push(yield* restoredOne({ objectClass: object.class, name: object.name, namespace }, caller, { bookmark: object.bookmark }));
    }

    return done;
  });
}

function restoredNamespace(env: OpsEnv, objectClass: (typeof RESTORED_CLASSES)[number]): Named<Restorable & Partial<NamesBytes>> | undefined {
  return { OrchestratorAgent: env.OrchestratorAgent, UserDO: env.UserDO, MailboxDO: env.MAILBOX, MossaicUserDO: env.MOSSAIC_USER, MossaicShardDO: env.MOSSAIC_SHARD }[objectClass];
}

opsRoutes.all('/ops/*', async () => err(404, 'Not found'));
