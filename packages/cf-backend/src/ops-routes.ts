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
import { Cause, Effect, Exit } from 'effect';
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
  MOSSAIC_USER?: Named<Restorable & { tenantShards(): Promise<number>; namedShards(): Promise<number[]> }>;
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
  /** Why what its rows name could not be read: the restore stands, and what it lost is unknown. */
  readonly unread?: string;
}

/** The classes whose rows name R2 bytes. A stub answers any name with a call, so a class is asked only by its name
 *  here (staging 2026-10-23: the account's object asked `opsMissing` failed, and the restore stopped there). */
const NAMES_BYTES: ReadonlySet<string> = new Set(['OrchestratorAgent', 'MailboxDO']);

/** One object to restore: its class, its name, and its namespace. */
interface ObjectNamed {
  readonly objectClass: string;
  readonly name: string;
  readonly namespace: Named<Restorable & Partial<NamesBytes>>;
}

/**
 * Arms one object's restore, ends it so it lands, then reads its history from a fresh start, and appends what it did to
 * `done` (an undo takes back only what the answer names): it landed when the object stands past the undo bookmark. One
 * that did not land is still armed and would land at the next eviction.
 */
function restoredOne({ objectClass, name, namespace }: ObjectNamed, caller: OpsCaller, to: RestoreTarget, done: ObjectRestored[]): Effect.Effect<void, KinuError> {
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
    const bytes = landed && NAMES_BYTES.has(objectClass) && missingOf !== undefined ? yield* bytesOf(() => missingOf(caller)) : {};

    diagnostics.event('ops.restore_answered', { ...said, current, landed, restart: ended._tag, missing: bytes.missing?.missing ?? 0, ...(bytes.unread !== undefined && { unread: bytes.unread }) });
    done.push({ ...said, current, landed, ...bytes });
  }).pipe(Effect.mapError((failure) => new KinuError(failure.code, `${objectClass} ${name}: ${renderThrownChain({ cause: failure })}`, { cause: failure })));
}

/** What a restored object's rows name that R2 no longer holds, or why that could not be read. */
function bytesOf(read: () => Promise<MissingBytes>): Effect.Effect<{ readonly missing?: MissingBytes; readonly unread?: string }> {
  return Effect.match(attempt({ doing: 'reading which of its bytes are gone', otherwise: 'unavailable' }, read), {
    onSuccess: (missing) => ({ missing }),
    onFailure: (failure) => ({ unread: renderThrownChain({ cause: failure }) }),
  });
}

/** A pool shard no restored record names: it held nothing of the tenant's at the moment. */
interface ObjectSkipped {
  readonly class: string;
  readonly name: string;
  readonly why: string;
}

/**
 * An account's objects, each to the same moment: the account, its mailbox, then its Drive's user object before each
 * shard its restored records name, so no shard's sweep sees a reference the restored tenant names as gone. A pool shard
 * none names held none of its bytes, and is skipped: one that never stored a chunk has no history to go back on
 * (staging dd3066a00, 2026-10-23, "This database has no history"). A bookmark is one object's, so an account goes back
 * by moment, never by bookmark.
 */
function accountRestored(
  env: OpsEnv, { name, caller, to }: { readonly name: string; readonly caller: OpsCaller; readonly to: RestoreTarget }, done: ObjectRestored[], skipped: ObjectSkipped[],
): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    yield* restoredOne({ objectClass: 'UserDO', name, namespace: env.UserDO }, caller, to, done);

    if (env.MAILBOX !== undefined) yield* restoredOne({ objectClass: 'MailboxDO', name, namespace: env.MAILBOX }, caller, to, done);
    const { MOSSAIC_USER: users, MOSSAIC_SHARD: shards } = env;

    if (users === undefined || shards === undefined) return;
    const names = tenantObjectNames(name);

    yield* restoredOne({ objectClass: 'MossaicUserDO', name: names.user, namespace: users }, caller, to, done);

    // Its shards are read from its records as of the moment: until it lands, they are now's.
    if (done.at(-1)?.landed !== true) return yield* new KinuError('unavailable', `the Drive's user object ${names.user} has not landed, so which shards it names at the moment is unknown`);
    const user = users.get(users.idFromName(names.user));
    const spans = yield* attempt({ doing: 'reading how many shards the Drive spans', otherwise: 'unavailable' }, () => user.tenantShards());
    const holding = new Set(yield* attempt({ doing: 'reading the shards its restored records name', otherwise: 'unavailable' }, () => user.namedShards()));

    for (let index = 0; index < Math.max(spans, ...holding, -1) + 1; index += 1) {
      if (holding.has(index)) yield* restoredOne({ objectClass: 'MossaicShardDO', name: names.shard(index), namespace: shards }, caller, to, done);
      else if (index < spans) skipped.push({ class: 'MossaicShardDO', name: names.shard(index), why: 'held nothing at the moment: no record of the restored Drive names it' });
    }
  });
}

/** A workspace or an account restored to a moment, or an earlier restore undone. */
opsRoutes.post('/ops/restore', (c) => settle(Effect.gen(function* () {
  if (!(yield* admitted(c.env, c.req.header('authorization')))) return err(401, REFUSED);
  const body = yield* Effect.promise(() => safeJson(c.req.raw, RestoreRequestSchema));

  if (body === null) return err(400, 'The body names one workspace or account and the moment ({ at }) or bookmark it goes back to.');
  const caller = yield* Effect.promise(() => opsCaller(c.env));
  const done: ObjectRestored[] = [];
  const skipped: ObjectSkipped[] = [];

  if ('undo' in body) return answered({ done, skipped }, yield* Effect.exit(undone(c.env, body.undo, caller, done)));
  const { object, to } = body;
  const name = 'email' in object ? yield* Effect.promise(() => accountIdFor(c.env, object.email)) : object.name;

  if (object.class === 'UserDO' && 'bookmark' in to) return err(400, 'An account goes back by a moment ({ at }): a bookmark names one object\'s history, and an account is several.');

  const work = object.class === 'UserDO'
    ? accountRestored(c.env, { name, caller, to }, done, skipped)
    : restoredOne({ objectClass: 'OrchestratorAgent', name, namespace: c.env.OrchestratorAgent }, caller, to, done);

  return answered({ done, skipped }, yield* Effect.exit(work));
})));

/** The objects a restore named and what each answered, those it skipped and why, and where it stopped: all landed and
 *  none stopped is 200. */
function answered({ done, skipped }: { readonly done: readonly ObjectRestored[]; readonly skipped: readonly ObjectSkipped[] }, ended: Exit.Exit<void, KinuError>): Response {
  const stopped = Exit.isFailure(ended) ? renderThrownChain({ cause: Cause.squash(ended.cause) }) : undefined;
  const landed = stopped === undefined && done.every((one) => one.landed);

  return json({ body: { objects: done, skipped, landed, ...(stopped !== undefined && { stopped }) } }, { status: landed ? 200 : 502 });
}

/** Each object back to its own bookmark, in the order the restore took them. */
function undone(
  env: OpsEnv, objects: readonly { readonly class: (typeof RESTORED_CLASSES)[number]; readonly name: string; readonly bookmark: string }[], caller: OpsCaller, done: ObjectRestored[],
): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    for (const object of objects) {
      const namespace = restoredNamespace(env, object.class);

      if (namespace === undefined) return yield* new KinuError('bad_input', `this deployment binds no ${object.class}`);
      yield* restoredOne({ objectClass: object.class, name: object.name, namespace }, caller, { bookmark: object.bookmark }, done);
    }
  });
}

function restoredNamespace(env: OpsEnv, objectClass: (typeof RESTORED_CLASSES)[number]): Named<Restorable & Partial<NamesBytes>> | undefined {
  return { OrchestratorAgent: env.OrchestratorAgent, UserDO: env.UserDO, MailboxDO: env.MAILBOX, MossaicUserDO: env.MOSSAIC_USER, MossaicShardDO: env.MOSSAIC_SHARD }[objectClass];
}

opsRoutes.all('/ops/*', async () => err(404, 'Not found'));
