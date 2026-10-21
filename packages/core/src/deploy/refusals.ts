// One catalog of Cloudflare's refusals (docs/SELF-DEPLOY-FLOW.md § 8): Cloudflare's own words, one plain sentence of
// what they mean, and one action. Keyed by Cloudflare's code, and by the endpoint where a code is shared or unmeasured.
// A refusal the catalog does not name keeps its words with "Retry this step"; the page offers to copy the words of any.
import { Cause, Effect } from 'effect';
import * as v from 'valibot';
import { renderThrownChain, type KinuError } from '../obs/index';
import { CloudflareApiError } from './cloudflare';
import type { DeployStepFailure } from './runner';

/** Cloudflare's words, verbatim: its message, its code, the HTTP status and the path it refused. */
export interface CloudflareWords {
  readonly message: string;
  readonly code?: number;
  readonly status?: number;
  readonly endpoint?: string;
}

export const CloudflareWordsSchema: v.GenericSchema<CloudflareWords> = v.object({
  message: v.string(),
  code: v.optional(v.number()),
  status: v.optional(v.number()),
  endpoint: v.optional(v.string()),
});

/** `href`: a Cloudflare dashboard page, opened beside the page. Absent: the page's own POST (sign in, retry). */
export interface DeployAction {
  readonly label: string;
  readonly href?: string;
}

const ActionSchema = v.object({ label: v.string(), href: v.optional(v.string()) });

export type DeployNeedId = 'r2' | 'plan' | 'signin-again';

/** A prerequisite only the person can meet. A run paused on one re-checks by itself and goes on once Cloudflare says it is met. */
export interface DeployNeed {
  readonly id: DeployNeedId;
  readonly sentence: string;
  readonly action: DeployAction;
  readonly details?: CloudflareWords;
}

export const DeployNeedSchema: v.GenericSchema<DeployNeed> = v.object({
  id: v.picklist(['r2', 'plan', 'signin-again']),
  sentence: v.string(),
  action: ActionSchema,
  details: v.optional(CloudflareWordsSchema),
});

/** A refusal the run stops on until the person acts. */
export interface DeployRefusal {
  readonly sentence: string;
  readonly action: DeployAction;
  readonly details: CloudflareWords;
}

export const DeployRefusalSchema: v.GenericSchema<DeployRefusal> = v.object({
  sentence: v.string(),
  action: ActionSchema,
  details: CloudflareWordsSchema,
});

interface CatalogEntry {
  /** 0: any code, matched by endpoint and status alone (an unmeasured refusal). */
  readonly code: number;
  /** A fragment of the refused path, where a code means different things on different endpoints. */
  readonly endpoint?: string;
  readonly status?: number;
  readonly need?: DeployNeedId;
  readonly sentence: string;
  readonly action: (account: string) => DeployAction;
}

const SIGN_IN_AGAIN: DeployAction = { label: 'Sign in again' };

const RETRY: DeployAction = { label: 'Retry this step' };

const CATALOG: readonly CatalogEntry[] = [
  // The code and message of the probe's fixture (deploy-lifecycle.test.ts); the live answer is to measure (§ 11).
  {
    code: 10_042, endpoint: '/r2/', need: 'r2',
    sentence: 'Cloudflare needs R2, its file storage, turned on before Kinu can keep your files. It\'s free; Cloudflare asks for a card the first time.',
    action: (account) => ({ label: 'Turn on R2', href: `https://dash.cloudflare.com/${account}/r2/overview` }),
  },
  // Unmeasured: the computer's container application on Workers Free. The plans page is wrangler 4.145.0's own hand-off.
  {
    code: 0, endpoint: '/containers/', status: 403, need: 'plan',
    sentence: 'Kinu\'s computer runs on Cloudflare\'s Workers Paid plan, $5 a month.',
    action: (account) => ({ label: 'Upgrade to Workers Paid', href: `https://dash.cloudflare.com/${account}/workers/plans` }),
  },
  // wrangler 4.145.0 reads 10000 as an authentication error; 9109 is a permission the sign-in did not carry.
  { code: 10_000, need: 'signin-again', sentence: 'Cloudflare no longer accepts this sign-in.', action: () => SIGN_IN_AGAIN },
  {
    code: 9109, need: 'signin-again',
    sentence: 'This sign-in does not carry a permission this step needs. Sign in again and leave every permission ticked.',
    action: () => SIGN_IN_AGAIN,
  },
  // wrangler 4.145.0: "You need to register a workers.dev subdomain", with the onboarding page.
  {
    code: 10_063, sentence: 'This account has no workers.dev subdomain yet.',
    action: (account) => ({ label: 'Choose one', href: `https://dash.cloudflare.com/${account}/workers/onboarding` }),
  },
  {
    code: 10_215, sentence: 'Cloudflare refused a secret while a newer version of the Worker was not serving yet.',
    action: () => RETRY,
  },
  // Its check reads one bundle in two modes, and the same release passed when asked again (platform-catalog
  // `worker.startup_ms`, f44999 2026-10-21): the person retries, the run never asks again by itself.
  {
    code: 10_021, sentence: 'Cloudflare\'s check of how fast Kinu starts ran slow this time. The same release usually passes when checked again.',
    action: () => RETRY,
  },
];

/** What a refusal means for the run: a prerequisite to pause on, or a refusal to stop on. */
export type DeployJudgement = { readonly need: DeployNeed } | { readonly refused: DeployRefusal };

export function judgeRefusal(words: CloudflareWords, account: string): DeployJudgement {
  const fits = (each: CatalogEntry) => (each.endpoint === undefined || (words.endpoint ?? '').includes(each.endpoint))
    && (each.status === undefined || each.status === words.status);

  // A refusal's own code first: a sign-in Cloudflare no longer accepts is that on any endpoint, a plan only where no code says otherwise.
  const entry = CATALOG.find((each) => each.code !== 0 && each.code === words.code && fits(each)) ?? CATALOG.find((each) => each.code === 0 && fits(each));

  if (entry === undefined) return { refused: { sentence: 'This step did not finish.', action: RETRY, details: words } };

  if (entry.need === undefined) return { refused: { sentence: entry.sentence, action: entry.action(account), details: words } };

  return { need: { id: entry.need, sentence: entry.sentence, action: entry.action(account), details: words } };
}

/** The grant is gone (an hour unattended, or a renewal Cloudflare refused): no Cloudflare words to show. */
export const SIGN_IN_AGAIN_NEED: DeployNeed = {
  id: 'signin-again',
  sentence: 'Kinu let go of your Cloudflare sign-in while this waited. Sign in again to carry on where it stopped.',
  action: SIGN_IN_AGAIN,
};

export function failureWords(failure: DeployStepFailure): CloudflareWords {
  return {
    message: failure.detail,
    code: failure.code === 0 ? undefined : failure.code,
    status: failure.status === 0 ? undefined : failure.status,
    endpoint: failure.endpoint,
  };
}

/** A failed read in Cloudflare's words where it was Cloudflare's, else in its own. */
export function causeWords(failed: Cause.Cause<KinuError>): CloudflareWords {
  const cause = Cause.squash(failed);

  if (cause instanceof CloudflareApiError) {
    return { message: cause.detail, code: cause.code === 0 ? undefined : cause.code, status: cause.status, endpoint: cause.path };
  }

  return { message: renderThrownChain({ cause }) };
}

/** A read's answer, or the words of its refusal. */
export type Heard<A> = { readonly answer: A } | { readonly words: CloudflareWords };

export function heard<A>(read: Effect.Effect<A, KinuError>): Effect.Effect<Heard<A>> {
  return read.pipe(Effect.matchCause({
    onSuccess: (answer): Heard<A> => ({ answer }),
    onFailure: (failed): Heard<A> => ({ words: causeWords(failed) }),
  }));
}
