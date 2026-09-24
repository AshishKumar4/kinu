/**
 * Who an eval run authenticates as, and where it may point. Identity: {@link EVAL_SERVICE_ACCOUNT} via
 * {@link EVAL_IDENTITY_ENV.token}, never a person's stored session; no credential means skip. Target: an
 * allowlist of the one deployment plus loopback, failing closed. Pure over its environment.
 */
import { homedir } from 'node:os';
import * as v from 'valibot';
import { EVAL_ACCOUNTS, USER_AI_PROXY_PATH, type EvalAccount } from '@kinu.run/core';
import { classify, renderThrownChain } from '@kinu.run/core/obs';
import { ambientByName, LIVE_MODEL_ENV } from './ambient-env';

export const EVAL_IDENTITY_ENV = {
  token: 'KINU_EVAL_TOKEN',
  origin: 'KINU_EVAL_ORIGIN',
} as const;

/** The account every eval acts as: the identity `env.DEV_USER_EMAIL` synthesizes on the deployment, so
 *  browser and CLI-bearer halves of a run agree on one user. */
export const EVAL_SERVICE_ACCOUNT = 'eval-service';

/** The deployment's synthesized identity; pinned to wrangler.jsonc's DEV_USER_EMAIL by this module's tests. */
export const EVAL_SERVICE_EMAIL = 'eval-service@kinu.run';

/** The named eval account a run acts as instead of the eval service's own: the first-run tier's device cases run
 *  as `devices`, so the machines they attach never sit in a workspace another tier's agent turns run in. */
export const EVAL_ACCOUNT_ENV = 'KINU_EVAL_ACCOUNT';

/** The named eval account `env` asks for, if any. A name that is no eval account throws: it must never fall back
 *  to the eval service's own. */
export function evalAccount(env: EnvSource = process.env): EvalAccount | undefined {
  const name = env[EVAL_ACCOUNT_ENV]?.trim();

  if (name === undefined || name === '') return undefined;
  const named = v.safeParse(v.picklist(EVAL_ACCOUNTS), name);

  if (!named.success) throw new Error(`${EVAL_ACCOUNT_ENV}=${name} names no eval account: one of ${EVAL_ACCOUNTS.join(', ')}`);

  return named.output;
}

/** Where the CLI bearer minted for `account` is kept: the eval service's own, else its named account's beside it. */
export function evalSessionPath(account: EvalAccount | undefined): string {
  const dir = `${homedir()}/.config/kinu/eval-session`;

  return account === undefined ? `${dir}/config.json` : `${dir}/${account}/config.json`;
}

/** The default eval target, pinned to wrangler.jsonc's CLI_PUBLIC_ORIGIN by tests. `workers_dev` is off,
 *  so no second host is allowed: it would expose the DEV_USER_EMAIL identity on an unwatched name. */
export const EVAL_DEPLOYMENT_ORIGIN = 'https://kinu.run';

/** Hosts that can only be the developer's machine. `[::1]` keeps its brackets because `URL.hostname` does. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'];

/** The prefix every eval-created workspace carries: makes stray rows attributable and `scripts/eval-workspaces.ts` cleanup one glob. */
export const EVAL_WORKSPACE_PREFIX = 'eval-';

type EnvSource = Record<string, string | undefined>;

/** A name reduced to what a workspace name and a directory name can both hold; shared so store and disk agree. */
export function evalNameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function evalWorkspaceName(subject: string): string {
  // The preview grammar caps names at 31 lowercase alphanumerics/hyphens; the random suffix wins over the subject.
  const rand = Math.random().toString(36).slice(2, 8);
  const room = 31 - EVAL_WORKSPACE_PREFIX.length - 1 - 6;
  const slug = evalNameSlug(subject).slice(0, room).replace(/-+$/, '');

  return `${EVAL_WORKSPACE_PREFIX}${slug}-${rand}`;
}

export type EvalTargetReason = 'deployment' | 'local';

export type EvalTargetVerdict =
  | { readonly kind: 'allowed'; readonly origin: string; readonly why: EvalTargetReason }
  | { readonly kind: 'refused'; readonly origin: string; readonly reason: string };

export function evalTargetVerdict(origin: string): EvalTargetVerdict {
  const normalized = origin.trim().replace(/\/+$/, '');

  if (!normalized) {
    return {
      kind: 'refused',
      origin: normalized,
      reason: `${EVAL_IDENTITY_ENV.origin} is set to an empty value, so nothing names where this `
        + 'run would go. Unset it to take the deployment default, or name an origin.',
    };
  }

  // `hostname`, not `host`, so ports and IPv6 brackets need no matching.
  let hostname: string;

  try {
    hostname = new URL(normalized).hostname;
  } catch (error) {
    return {
      kind: 'refused',
      origin: normalized,
      reason: `${normalized} is not a URL (${renderThrownChain({ cause: error })}), so no host can be checked against the eval allowlist`,
    };
  }

  if (LOOPBACK_HOSTS.includes(hostname)) {
    return { kind: 'allowed', origin: normalized, why: 'local' };
  }

  if (normalized === EVAL_DEPLOYMENT_ORIGIN) {
    return { kind: 'allowed', origin: normalized, why: 'deployment' };
  }

  return {
    kind: 'refused',
    origin: normalized,
    reason: `${normalized} is not an eval target. Tests and evals run against `
      + `${EVAL_DEPLOYMENT_ORIGIN} or a loopback dev server. Set ${EVAL_IDENTITY_ENV.origin} `
      + `to one of those.`,
  };
}

export type EvalModelEndpointVerdict =
  | { readonly kind: 'checked'; readonly target: EvalTargetVerdict }
  /** Fronts a model and no Kinu deployment, so there is no target to rule on. */
  | { readonly kind: 'gateway' };

/**
 * Whether an eval may send its credential to the model endpoint `baseUrl`. The origin allowlist decides
 * first; only a refused origin is checked for the {@link USER_AI_PROXY_PATH} route, so an undeclared
 * origin bearing that route is refused rather than read as a gateway.
 */
export function evalModelEndpointVerdict(baseUrl: string): EvalModelEndpointVerdict {
  let url: URL;

  try {
    url = new URL(baseUrl.trim());
  } catch (error) {
    // Not a URL: reaches nothing, and the provider stack refuses it on the first call.
    if (classify({ cause: error }) !== 'malformed-input') throw error;

    return { kind: 'gateway' };
  }

  const target = evalTargetVerdict(url.origin);

  if (target.kind === 'allowed') return { kind: 'checked', target };

  if (url.pathname.replace(/\/+$/, '') === USER_AI_PROXY_PATH) return { kind: 'checked', target };

  return { kind: 'gateway' };
}

export interface RefusedEvalEndpoint {
  readonly variable: string;
  readonly reason: string;
}

/** The first model endpoint in `env` aimed at a disallowed deployment, reported by variable from {@link LIVE_MODEL_ENV}. */
export function refusedEvalEndpoint(env: EnvSource = ambientByName(LIVE_MODEL_ENV.gatewayURL)): RefusedEvalEndpoint | null {
  for (const variable of LIVE_MODEL_ENV.gatewayURL) {
    const value = env[variable]?.trim();

    if (!value) continue;
    const verdict = evalModelEndpointVerdict(value);

    if (verdict.kind === 'checked' && verdict.target.kind === 'refused') {
      return { variable, reason: verdict.target.reason };
    }
  }

  return null;
}

export interface EvalIdentity {
  readonly origin: string;
  readonly token: string;
  /** Always {@link EVAL_SERVICE_ACCOUNT}; carried so a caller reports the identity it used. */
  readonly account: string;
  readonly why: EvalTargetReason;
  readonly describe: string;
}

export type EvalIdentityResolution =
  | { readonly kind: 'ready'; readonly identity: EvalIdentity }
  | { readonly kind: 'absent'; readonly reason: string }
  /** A credential pointed somewhere it may not go. Never a skip. */
  | { readonly kind: 'refused'; readonly reason: string };

/** The eval-service identity for this environment. `absent` is not an error; a disallowed target is. */
export function resolveEvalIdentity(env: EnvSource = ambientByName(Object.values(EVAL_IDENTITY_ENV))): EvalIdentityResolution {
  const token = env[EVAL_IDENTITY_ENV.token]?.trim();
  const origin = env[EVAL_IDENTITY_ENV.origin]?.trim() ?? EVAL_DEPLOYMENT_ORIGIN;

  if (!token) {
    return {
      kind: 'absent',
      reason: `no eval credential. Sign the isolated ${EVAL_SERVICE_ACCOUNT} session into ${origin} `
        + `or export ${EVAL_IDENTITY_ENV.token} — a person's signed-in session is never borrowed, `
        + 'so without it every live suite skips.',
    };
  }

  const verdict = evalTargetVerdict(origin);

  if (verdict.kind === 'refused') {
    return { kind: 'refused', reason: verdict.reason };
  }

  return {
    kind: 'ready',
    identity: {
      origin: verdict.origin,
      token,
      account: EVAL_SERVICE_ACCOUNT,
      why: verdict.why,
      describe: `${EVAL_SERVICE_ACCOUNT} @ ${verdict.origin} (${verdict.why})`,
    },
  };
}
