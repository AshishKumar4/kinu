/**
 * WHO an eval run authenticates as, and WHERE it is allowed to point.
 *
 * THE DEFECT THIS EXISTS FOR, measured on the owner's own account on
 * 2026-08-20: `GET /api/cli/workspaces` on the production origin returned 28
 * rows, of which 23 were test debris — twenty-two `drill*` workspaces and one
 * `settle-probe`, minted across 2026-08-18/19 by harnesses driving the owner's
 * signed-in session against production. Nothing in the tree had refused either
 * half of that. `scripts/eval-credentials.ts` promoted `~/.kinu/config.json`
 * to a live target on purpose, and no surface asked whether the origin it was
 * pointed at served real users. So a test run was indistinguishable from the
 * owner working, on the account that holds his real workspaces.
 *
 * Two rules, and neither is a preference:
 *
 *   1. IDENTITY. An eval authenticates as {@link EVAL_SERVICE_ACCOUNT} using a
 *      credential named in the environment ({@link EVAL_IDENTITY_ENV.token}),
 *      never a session belonging to a person. There is no fallback to a stored
 *      session: a harness with no eval credential skips, which is a result, and
 *      the skip-ratchet holds it accountable.
 *   2. TARGET. An eval may reach the staging deployment or a loopback dev
 *      server. Anything else is refused unless
 *      {@link EVAL_IDENTITY_ENV.allowProd} names the exception.
 *
 * RULE 2 IS AN ALLOWLIST, and that is the whole of its value. A denylist of
 * production hostnames permits every origin nobody has thought of yet — a new
 * prod, a colleague's deployment, a typo that resolves — which is the class of
 * mistake that put those 23 rows on the owner's account. This fails closed: an
 * origin nobody has declared safe is refused, and the refusal says which
 * variable makes it run.
 *
 * Pure over its environment, so the guard is testable without a credential and
 * without a network.
 */
import { USER_AI_PROXY_PATH } from '@kinu.run/core';
import { classify, renderThrownChain } from '@kinu.run/core/obs';
import { LIVE_MODEL_ENV } from './ambient-env';

/** The three variables that decide identity and target. One object so a failure
 *  message, a shell script and the docs can name them without a second copy. */
export const EVAL_IDENTITY_ENV = {
  token: 'KINU_EVAL_TOKEN',
  origin: 'KINU_EVAL_ORIGIN',
  allowProd: 'KINU_EVAL_ALLOW_PROD',
} as const;

/** The account every eval run acts as. Server-side this is the identity
 *  `env.DEV_USER_EMAIL` synthesizes on the staging deployment, so the browser
 *  half and the CLI-bearer half of a run agree on one user. */
export const EVAL_SERVICE_ACCOUNT = 'eval-service';

/** The staging deployment's synthesized identity, and so the mailbox the
 *  eval-service account is keyed by. Pinned to `env.staging`'s DEV_USER_EMAIL
 *  by this module's tests. */
export const EVAL_SERVICE_EMAIL = 'eval-service@kinu.run';

/** The default eval target: the staging deployment, whose ONE origin this is.
 *  Pinned to `env.staging`'s CLI_PUBLIC_ORIGIN by this module's tests.
 *
 *  Both deployments set `workers_dev: false`, so there is no second host to
 *  allow: a `workers.dev` origin fronting a DEV_USER_EMAIL identity would be an
 *  auth bypass on a second name nobody watches. */
export const EVAL_STAGING_ORIGIN = 'https://staging.kinu.run';

/** Hosts that can only be a developer's own machine. `[::1]` keeps its brackets
 *  because `URL.hostname` does — and the parser normalizes any longhand IPv6
 *  loopback to that one spelling, so this covers every way of writing it. */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'];

/**
 * The prefix every workspace an eval creates carries.
 *
 * Load-bearing rather than cosmetic: it is what makes a stray row attributable
 * and what makes the cleanup in `scripts/eval-workspaces.ts` one glob rather
 * than a judgement call over a list of names. The debris this module was
 * written for was named `drill*` and `settle-probe`, and nobody could tell from
 * the account which harness had made either.
 */
export const EVAL_WORKSPACE_PREFIX = 'eval-';

type EnvSource = Record<string, string | undefined>;

/**
 * A workspace name an eval may create, prefixed and suffixed so it is both
 * attributable and unique.
 *
 * `subject` names the suite, not the case: the point of the name is that a row
 * surviving teardown says what made it.
 */
export function evalWorkspaceName(subject: string): string {
  const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${EVAL_WORKSPACE_PREFIX}${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Why an origin was allowed. Reported rather than inferred, because "this ran
 *  against staging" and "this ran against production because someone said so"
 *  are different facts about a measurement. */
export type EvalTargetReason = 'staging' | 'local' | 'override';

export type EvalTargetVerdict =
  | { readonly kind: 'allowed'; readonly origin: string; readonly why: EvalTargetReason }
  | { readonly kind: 'refused'; readonly origin: string; readonly reason: string };

/**
 * Whether an eval may point at `origin`.
 *
 * The override is tested FIRST and reported as itself. An operator who sets
 * {@link EVAL_IDENTITY_ENV.allowProd} has named an exception, and a run that
 * took it must say so in the same line that says where it went — otherwise the
 * override is indistinguishable from the origin having been safe all along.
 */
export function evalTargetVerdict(origin: string, env: EnvSource = process.env): EvalTargetVerdict {
  const normalized = origin.trim().replace(/\/+$/, '');
  if (!normalized) {
    return {
      kind: 'refused',
      origin: normalized,
      reason: `${EVAL_IDENTITY_ENV.origin} is set to an empty value, so nothing names where this `
        + 'run would go. Unset it to take the staging default, or name an origin.',
    };
  }

  // `hostname` rather than `host`, so a port and IPv6 brackets do not have to be
  // matched around: `http://localhost:5173` and `http://[::1]:8787` are the two
  // shapes a local dev server actually arrives as.
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

  if (env[EVAL_IDENTITY_ENV.allowProd]?.trim() === '1') {
    return { kind: 'allowed', origin: normalized, why: 'override' };
  }
  if (LOOPBACK_HOSTS.includes(hostname)) {
    return { kind: 'allowed', origin: normalized, why: 'local' };
  }
  if (normalized === EVAL_STAGING_ORIGIN) {
    return { kind: 'allowed', origin: normalized, why: 'staging' };
  }
  return {
    kind: 'refused',
    origin: normalized,
    reason: `${normalized} is not an eval target. Tests and evals run against `
      + `${EVAL_STAGING_ORIGIN}, or a loopback dev server, so they can never write into a `
      + `deployment that serves real users. To make this run anyway, set `
      + `${EVAL_IDENTITY_ENV.allowProd}=1 — which records that somebody chose it.`,
  };
}

export type EvalModelEndpointVerdict =
  /** An origin the allowlist ruled on, either way. */
  | { readonly kind: 'checked'; readonly target: EvalTargetVerdict }
  /** Fronts a model and no Kinu deployment, so it creates nothing and there is
   *  no target to rule on. */
  | { readonly kind: 'gateway' };

/**
 * Whether an eval may send its credential to the model endpoint `baseUrl`.
 *
 * A model endpoint arrives as a base URL rather than an origin, and the two
 * variables that carry one hold either shape: `.env.example` documents an AI
 * Gateway, and `.github/workflows/eval.yml` held a repository secret that could
 * hold either. Measured on 2026-08-21, `resolveLLMConfig` turns
 * `https://kinu.run/api/user/ai/v1` plus a bearer into
 * `{ name: 'workers-ai', baseURL: <that>, Authorization: 'Bearer …' }` — the
 * shape that authenticates against a deployment, not a gateway's
 * `cf-aig-authorization` — so that pair reaches production's whole API.
 *
 * THE ORIGIN DECIDES FIRST, against the one allowlist. An allowed origin needs
 * no further reasoning, whatever path follows it. Only a refused origin raises
 * the second question, which is whether refusing it would break the gateway
 * path the tier legitimately uses — and there the deployment's own inference
 * route answers, because {@link USER_AI_PROXY_PATH} is the single declaration of
 * that route, shared by the URL builder, the server handler and the auth router.
 *
 * The order matters more than either test. Origin-first keeps production out of
 * this module: naming the deployments would turn the allowlist into a list of
 * hosts to distrust, and every origin nobody had thought of yet would then read
 * as a gateway and pass. This way an undeclared origin bearing the inference
 * route is refused, including one belonging to nobody here.
 */
export function evalModelEndpointVerdict(
  baseUrl: string,
  env: EnvSource = process.env,
): EvalModelEndpointVerdict {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch (error) {
    // Not a URL, so it names no deployment and reaches nothing. The provider
    // stack refuses it on the first call.
    if (classify({ cause: error }) !== 'malformed-input') throw error;
    return { kind: 'gateway' };
  }

  const target = evalTargetVerdict(url.origin, env);
  if (target.kind === 'allowed') return { kind: 'checked', target };
  if (url.pathname.replace(/\/+$/, '') === USER_AI_PROXY_PATH) return { kind: 'checked', target };
  return { kind: 'gateway' };
}

/** A model endpoint an eval may not use, and the variable that carries it. */
export interface RefusedEvalEndpoint {
  readonly variable: string;
  readonly reason: string;
}

/**
 * The first model endpoint in `env` aimed at a deployment an eval may not reach.
 *
 * Reported by VARIABLE, because a variable is what an operator changes. The
 * names come from {@link LIVE_MODEL_ENV} rather than a second list, so a
 * spelling added there is checked here.
 */
export function refusedEvalEndpoint(env: EnvSource = process.env): RefusedEvalEndpoint | null {
  for (const variable of LIVE_MODEL_ENV.gatewayURL) {
    const value = env[variable]?.trim();
    if (!value) continue;
    const verdict = evalModelEndpointVerdict(value, env);
    if (verdict.kind === 'checked' && verdict.target.kind === 'refused') {
      return { variable, reason: verdict.target.reason };
    }
  }
  return null;
}

/** The eval-service credential and the deployment it is good for. */
export interface EvalIdentity {
  readonly origin: string;
  readonly token: string;
  /** Always {@link EVAL_SERVICE_ACCOUNT}; carried so a caller reports the
   *  identity it used rather than the one it assumes. */
  readonly account: string;
  readonly why: EvalTargetReason;
  /** The one line a run prints before it spends anything. */
  readonly describe: string;
}

export type EvalIdentityResolution =
  | { readonly kind: 'ready'; readonly identity: EvalIdentity }
  /** No eval credential at all — the legitimate skip. */
  | { readonly kind: 'absent'; readonly reason: string }
  /** A credential pointed somewhere it may not go. Never a skip: someone meant
   *  this to run, and where it would have gone is the thing to say out loud. */
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * The eval-service identity for this environment.
 *
 * `absent` is the reproduce-anywhere path and is deliberately not an error: a
 * tier that cannot run without a secret is a tier nobody can reproduce. What is
 * an error is a credential aimed at a deployment the allowlist does not cover.
 */
export function resolveEvalIdentity(env: EnvSource = process.env): EvalIdentityResolution {
  const token = env[EVAL_IDENTITY_ENV.token]?.trim();
  // `evalTargetVerdict` normalizes, so this only has to choose the default.
  const origin = env[EVAL_IDENTITY_ENV.origin]?.trim() ?? EVAL_STAGING_ORIGIN;

  if (!token) {
    return {
      kind: 'absent',
      reason: `no eval credential. Sign the isolated ${EVAL_SERVICE_ACCOUNT} session into ${origin} `
        + `or export ${EVAL_IDENTITY_ENV.token} — a person's signed-in session is never borrowed, `
        + 'so without it every live suite skips.',
    };
  }

  const verdict = evalTargetVerdict(origin, env);
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
