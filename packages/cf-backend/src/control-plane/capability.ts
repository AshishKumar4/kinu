/**
 * The control plane's capability tokens: the two grades, the derivation, and the
 * gate every ControlPlaneDO method calls first.
 *
 * SPLIT FROM `admin-caller.ts` FOR A STRUCTURAL REASON, not for tidiness. That
 * file answers "is this human an operator", which needs `AuthIdentity` and
 * therefore the browser-session module — and through it the whole user plane. The
 * Durable Object needs only "is this call from Worker code holding the root
 * secret", which needs nothing but the secret and a HMAC. Keeping them in one
 * module put `auth/session` in the DO's module graph, and a Durable Object whose
 * types reach the production `Env` cannot be compiled by the workerd test project
 * — the same drift `tests/workerd/tsconfig.json` exists to prevent.
 *
 * THE TWO GRADES ARE A REAL ATTENUATION, not documentation. `ingest` is held by
 * the feedback endpoint and the registration feed — paths any signed-in user can
 * cause to run. `admin` is held only by `control-plane/routes.ts`, after the HTTP
 * boundary has matched an operator email. A bug in the feedback handler therefore
 * cannot read another user's workspaces or run a mutation, because the token it
 * holds does not resolve to a grade that permits either. If one token served
 * both, the grade column would be a comment.
 *
 * The same root secret as the user plane, under a different label, for the
 * reasons already written down in `user/workspace-capability.ts`: one thing to
 * provision, one thing to rotate, no second key whose absence is a silent
 * downgrade. Domain separation is the label, so neither value can stand in for
 * the other.
 */
import { hmacSha256Hex } from '../lib/crypto';
import * as v from 'valibot';

/**
 * What a caller is allowed to do.
 *
 * `ingest` — append a fact about the caller's own activity. Reachable from any
 * signed-in user's request path.
 *
 * `admin` — read across users, and mutate. Reachable only after the HTTP
 * boundary has matched an operator email.
 */
export type ControlGrade = 'ingest' | 'admin';

const GRADE_RANK = { ingest: 1, admin: 2 } satisfies Record<ControlGrade, number>;

/**
 * The attenuation matrix, as data rather than as a check repeated in thirty
 * method bodies. Every gated ControlPlaneDO method names one of these, and
 * `requireControl` is called first thing in that method — so adding a method
 * without a capability is a type error at the call to the gate, not a hole.
 */
const CONTROL_PLANE_CAPABILITIES = {
  // Feeds. A signed-in user's own request causes these.
  'index.observe': 'ingest',
  'index.workspace': 'ingest',
  'index.forget': 'ingest',
  'feedback.write': 'ingest',
  // Reads across users. Operators only.
  'overview.read': 'admin',
  'users.read': 'admin',
  'workspaces.read': 'admin',
  'feedback.read': 'admin',
  'audit.read': 'admin',
  // The audit log's only writer is the admin route itself.
  'audit.write': 'admin',
  // Reconciliation replaces index rows from the owning UserDO. An admin action
  // because it fans out reads over a user's whole roster.
  'index.reconcile': 'admin',
} as const satisfies Record<string, ControlGrade>;

export type ControlCapability = keyof typeof CONTROL_PLANE_CAPABILITIES;

/** What a Worker route presents to ControlPlaneDO. Opaque on purpose: the only
 *  way to obtain one is `internalCaller` or `adminCaller`, both of which need
 *  the deployment's root secret. */
export interface ControlCaller {
  readonly controlToken: string;
}

const INGEST_LABEL = 'kinu.control-plane.ingest.v1';
const ADMIN_LABEL = 'kinu.control-plane.admin.v1';

/** Derived tokens, cached per (secret, label). The derivation is deterministic,
 *  so the cache holds nothing the isolate was not already holding. */
const derived = new Map<string, Promise<string>>();

function controlToken(env: ControlSecretEnv, label: string): Promise<string> {
  const secret = (env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim();
  if (!secret) throw new ControlPlaneUnconfiguredError();
  const key = `${label}\u0000${secret}`;
  let pending = derived.get(key);
  if (!pending) {
    pending = hmacSha256Hex(secret, label);
    derived.set(key, pending);
  }
  return pending;
}

export interface ControlSecretEnv {
  CREDENTIAL_ENCRYPTION_KEY?: string;
}

/** Thrown when the deployment holds no root secret, so no caller can be
 *  derived. Its own class because the answer is a deliberate 503 rather than an
 *  opaque 500 — the plane is unconfigured, not broken. */
export class ControlPlaneUnconfiguredError extends Error {
  constructor() {
    super(
      'The control plane is not configured: CREDENTIAL_ENCRYPTION_KEY is not set. '
      + 'See docs/DEPLOYMENT.md.',
    );
    this.name = 'ControlPlaneUnconfiguredError';
  }
}

/** The attenuated caller for paths a signed-in user can cause: feedback
 *  submission and the index feed. Cannot read across users and cannot mutate. */
export async function internalCaller(env: ControlSecretEnv): Promise<ControlCaller> {
  return { controlToken: await controlToken(env, INGEST_LABEL) };
}

/** The operator token itself. `adminCaller` in `admin-caller.ts` is the only
 *  intended caller: it requires proof the HTTP boundary matched an operator, and
 *  keeping that requirement there is what stops an admin token being minted from
 *  a bare identity. */
export async function adminControlToken(env: ControlSecretEnv): Promise<ControlCaller> {
  return { controlToken: await controlToken(env, ADMIN_LABEL) };
}

/** Thrown by `requireControl`. Crosses the Worker→DO RPC boundary as its
 *  message, like `CapabilityDeniedError` does for the user plane — and only as
 *  its message: workerd erases the subclass, so this class is module-private and
 *  the wording is the whole contract. `unit-control-plane-do-workerd.test.ts`
 *  measures both halves. */
class ControlDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlDeniedError';
  }
}

/**
 * The gate every ControlPlaneDO method calls first.
 *
 * Fails closed at each step: an unrecognized shape, a token that matches
 * neither derivation, or a grade below the capability's requirement is denied
 * rather than defaulted. Comparison is over the derived hex digest of a
 * fixed-length HMAC, and both candidates are computed before either is
 * compared, so the branch order carries no information about the secret.
 */
export async function requireControl(
  env: ControlSecretEnv,
  caller: PresentedCaller,
  capability: ControlCapability,
): Promise<ControlGrade> {
  const grade = await resolveGrade(env, caller);
  const required = CONTROL_PLANE_CAPABILITIES[capability];
  if (grade === null || GRADE_RANK[grade] < GRADE_RANK[required]) {
    throw new ControlDeniedError(
      `${capability} requires the control plane's ${required} capability. `
      + `This caller ${grade === null ? 'presented no recognized capability' : `holds only ${grade}`}.`,
    );
  }
  return grade;
}

/**
 * What a caller presents at the gate.
 *
 * A NAMED type rather than `unknown`, and deliberately wider than
 * `ControlCaller`: this value crosses the Worker→DO RPC boundary, where the
 * caller chooses what to send, so the gate has to be able to receive something
 * that is not a caller at all and refuse it. Naming the received set is what
 * makes `resolveGrade`'s parse the ENFORCEMENT and this annotation the CONTRACT;
 * `unknown` said neither.
 */
export type PresentedCaller = ControlCaller | Partial<ControlCaller> | null | undefined;

/** The caller shape, parsed rather than asserted. It arrives over the Worker→DO
 *  RPC boundary, so it is outside-controlled data by the same reasoning that
 *  makes `UserCallerSchema` a schema in the user plane: an inline cast would
 *  fabricate the shape and then trust it. */
const ControlCallerSchema: v.GenericSchema<ControlCaller> = v.object({
  controlToken: v.pipe(v.string(), v.nonEmpty()),
});

async function resolveGrade(
  env: ControlSecretEnv, caller: PresentedCaller,
): Promise<ControlGrade | null> {
  const parsed = v.safeParse(ControlCallerSchema, caller);
  if (!parsed.success) return null;
  const token = parsed.output.controlToken;
  const [ingest, admin] = await Promise.all([
    controlToken(env, INGEST_LABEL),
    controlToken(env, ADMIN_LABEL),
  ]);
  if (token === admin) return 'admin';
  if (token === ingest) return 'ingest';
  return null;
}

