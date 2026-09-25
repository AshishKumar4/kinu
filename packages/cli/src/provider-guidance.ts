/** Failure → `{message, hint}`: classify by status/code first, wording only as fallback. */

import { describeProviderError, providerFailureFacts } from '@kinu.run/core';
import { MODEL_OPTION_FLAG } from './options';

interface GuidedFailure {
  /** Never empty. */
  message: string;
  hint?: string;
}

const PROVIDER_LIST_HINT = 'See what is connected: kinu provider list';

const CREDENTIAL_HINT =
  `The provider rejected the credential. Reconnect it: kinu provider connect <provider>. ${PROVIDER_LIST_HINT}`;

const ACCOUNT_HINT =
  'The provider account cannot serve requests (billing or quota). Fix it with the provider, '
  + `or switch: kinu provider connect <provider>. ${PROVIDER_LIST_HINT}`;

const MODEL_HINT =
  'That model is not available on the connected provider. Pick another with /model in chat, '
  + `or pass ${MODEL_OPTION_FLAG} <provider>/<id>.`;

const RATE_LIMIT_HINT =
  'The provider is rate-limiting this account. Retry shortly, or switch model with /model in chat.';

const CONTEXT_HINT =
  'The turn exceeded the model context window. Start a fresh session, or choose a larger-context '
  + 'model with /model.';

/** 402 is the account, not the key: never hint a reconnect. */
const HINT_BY_STATUS = new Map([
  [401, CREDENTIAL_HINT],
  [402, ACCOUNT_HINT],
  [403, CREDENTIAL_HINT],
  [404, MODEL_HINT],
  [429, RATE_LIMIT_HINT],
]);

/** Codes more specific than their status: context overflow and malformed request are both 400. */
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

/** Wording fallback when no status or code survived; ordered because classes overlap. */
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

/** Messages that already name their commands get no hint. */
export function guideFailure(failure: { readonly cause: unknown }): GuidedFailure {
  const message = describeProviderError({ cause: failure.cause });

  if (/kinu [a-z]/.test(message)) return { message };
  const facts = providerFailureFacts({ cause: failure.cause });

  // Code is more specific than status.
  const hint = (facts.providerCode === undefined ? undefined : HINT_BY_PROVIDER_CODE.get(facts.providerCode))
    ?? (facts.status === undefined ? undefined : HINT_BY_STATUS.get(facts.status))
    ?? CLASSES.find((entry) => entry.match.test(message))?.hint;

  return hint === undefined ? { message } : { message, hint };
}
