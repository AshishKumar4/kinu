/**
 * One place that turns a failure into something a user can act on.
 *
 * Every CLI surface used to render `err.message` and stop there, so a provider
 * rejection arrived as whatever the endpoint happened to say — often a JSON
 * body with no hint of which Kinu command fixes it. This module keeps the
 * provider's own words (they are the evidence) and appends the exact next
 * command for the failure class it recognises.
 *
 * It classifies the FACTS the provider boundary preserved — the HTTP status and
 * the provider's own stable code — and only falls back to matching wording for
 * the classes no status distinguishes. Matching prose alone was the whole
 * defect: a 401 and a 402 read as the same sentence on one gateway and as two
 * different sentences on the next, and every rewording silently dropped a hint.
 */

import { describeProviderError, providerFailureFacts } from '@kinu.run/core';

export interface GuidedFailure {
  /** The failure in the provider's own words. Never empty —
   *  `describeProviderError` always resolves to something readable. */
  message: string;
  /** The next command to run, when the failure class implies one. */
  hint?: string;
}

const PROVIDER_LIST_HINT = 'See what is connected: kinu provider list';

const CREDENTIAL_HINT =
  `The provider rejected the credential. Reconnect it: kinu provider connect <provider> — ${PROVIDER_LIST_HINT}`;
const ACCOUNT_HINT =
  'The provider account cannot serve requests (billing or quota). Fix it with the provider, '
  + `or switch: kinu provider connect <provider> — ${PROVIDER_LIST_HINT}`;
const MODEL_HINT =
  'That model is not available on the connected provider. Pick another with /model in chat, '
  + 'or pass --model <provider>/<id>.';
const RATE_LIMIT_HINT =
  'The provider is rate-limiting this account. Retry shortly, or switch model with /model in chat.';
const CONTEXT_HINT =
  'The turn exceeded the model context window. Start a fresh session, or choose a larger-context '
  + 'model with /model.';

/** Statuses that name their own remedy. 402 is the account, not the key: a
 *  valid credential on an unpaid account is the one case the credential hint
 *  sends the user to reconnect for nothing. */
const HINT_BY_STATUS = new Map([
  [401, CREDENTIAL_HINT],
  [402, ACCOUNT_HINT],
  [403, CREDENTIAL_HINT],
  [404, MODEL_HINT],
  [429, RATE_LIMIT_HINT],
]);

/** Provider codes that are more specific than the status they arrive with —
 *  a context overflow and a malformed request are both 400. */
const HINT_BY_PROVIDER_CODE = new Map([
  ['context_length_exceeded', CONTEXT_HINT],
  ['string_above_max_length', CONTEXT_HINT],
  ['rate_limit_exceeded', RATE_LIMIT_HINT],
  ['insufficient_quota', ACCOUNT_HINT],
  ['billing_not_active', ACCOUNT_HINT],
  ['billing_hard_limit_reached', ACCOUNT_HINT],
  ['invalid_api_key', CREDENTIAL_HINT],
  ['model_not_found', MODEL_HINT],
]);

/**
 * The classes no structured fact reached us for.
 *
 * Reached only when the failure carried neither a status nor a provider code —
 * a stream `error` event that is a bare string, an endpoint that answers a
 * status line as prose. The status words stay in the patterns for exactly that
 * case: they are the only evidence there is when nothing structured survived.
 *
 * Ordered because the classes overlap: an expired key is reported as a 401
 * with billing words by some gateways, and the credential fix comes first.
 */
const CLASSES: ReadonlyArray<{ match: RegExp; hint: string }> = [
  {
    match: /\b(401|403)\b|unauthorized|forbidden|invalid[_ -]?api[_ -]?key|invalid[_ -]?token|authentication[_ -]?(failed|error)|expired[_ -]?token|no credential|not authenticated/i,
    hint: CREDENTIAL_HINT,
  },
  {
    match: /billing|insufficient[_ -]?quota|payment|credit balance|exceeded your current quota|account is not active/i,
    hint: ACCOUNT_HINT,
  },
  {
    match: /model[_ -]?not[_ -]?found|does not exist|unknown model|no such model|unsupported[_ -]?model/i,
    hint: MODEL_HINT,
  },
  {
    match: /rate[_ -]?limit|too many requests|overloaded/i,
    hint: RATE_LIMIT_HINT,
  },
  {
    match: /context[_ -]?length|too many tokens|maximum context|prompt is too long/i,
    hint: CONTEXT_HINT,
  },
];

/**
 * Render any failure — a thrown value, or the already-stringified message a
 * stream `error` event carries — as `{message, hint}`. Errors that already
 * tell the user what to run (the "No LLM configured" family names its own
 * commands) keep their own wording rather than gaining a second, weaker hint.
 */
export function guideFailure(failure: { readonly cause: unknown }): GuidedFailure {
  const message = describeProviderError({ cause: failure.cause });
  if (/kinu [a-z]/.test(message)) return { message };
  const facts = providerFailureFacts({ cause: failure.cause });
  // Code before status: it is the more specific of the two when both arrive.
  const hint = (facts.providerCode === undefined ? undefined : HINT_BY_PROVIDER_CODE.get(facts.providerCode))
    ?? (facts.status === undefined ? undefined : HINT_BY_STATUS.get(facts.status))
    ?? CLASSES.find((entry) => entry.match.test(message))?.hint;
  return hint === undefined ? { message } : { message, hint };
}
