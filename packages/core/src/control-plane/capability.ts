/**
 * Control-plane capability tokens and the gate every ControlPlaneDO method calls first.
 * Kept apart from `admin-caller.ts` so `auth/session` stays out of the DO's module
 * graph (the workerd test project cannot compile the production `Env`).
 * Derived from the user plane's root secret under a distinct label.
 */
import { hmacSha256Hex } from '../utils/crypto';
import * as v from 'valibot';

/** `ingest`: any signed-in user's request path. `admin`: only after the HTTP
 *  boundary matched an operator email. */
export type ControlGrade = 'ingest' | 'admin';

const GRADE_RANK = { ingest: 1, admin: 2 } satisfies Record<ControlGrade, number>;

const CONTROL_PLANE_CAPABILITIES = {
  'index.observe': 'ingest',
  'index.workspace': 'ingest',
  'index.forget': 'ingest',
  'feedback.write': 'ingest',
  'shares.index': 'ingest',
  'overview.read': 'admin',
  'users.read': 'admin',
  'workspaces.read': 'admin',
  'feedback.read': 'admin',
  'audit.read': 'admin',
  'audit.write': 'admin',
  // Fans out reads over a user's whole roster.
  'index.reconcile': 'admin',
} as const satisfies Record<string, ControlGrade>;

export type ControlCapability = keyof typeof CONTROL_PLANE_CAPABILITIES;

/** Obtainable only via `internalCaller` or `adminCaller`, both needing the root secret. */
export interface ControlCaller {
  readonly controlToken: string;
}

const INGEST_LABEL = 'kinu.control-plane.ingest.v1';

const ADMIN_LABEL = 'kinu.control-plane.admin.v1';

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

/** Maps to a deliberate 503: the plane is unconfigured, not broken. */
export class ControlPlaneUnconfiguredError extends Error {
  constructor() {
    super(
      'The control plane is not configured: CREDENTIAL_ENCRYPTION_KEY is not set. '
      + 'See docs/DEPLOYMENT.md.',
    );
    this.name = 'ControlPlaneUnconfiguredError';
  }
}

/** Cannot read across users or mutate. */
export async function internalCaller(env: ControlSecretEnv): Promise<ControlCaller> {
  return { controlToken: await controlToken(env, INGEST_LABEL) };
}

/** Only `adminCaller` in `admin-caller.ts` should call this; it requires proof of an operator. */
export async function adminControlToken(env: ControlSecretEnv): Promise<ControlCaller> {
  return { controlToken: await controlToken(env, ADMIN_LABEL) };
}

/** workerd erases the subclass across RPC, so the message is the whole contract. */
class ControlDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlDeniedError';
  }
}

/** Fails closed. Both derivations are computed before comparing, so branch order leaks nothing. */
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

/** Wider than `ControlCaller`: the RPC caller chooses what to send, and the gate must refuse it. */
export type PresentedCaller = ControlCaller | Partial<ControlCaller> | null | undefined;

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

