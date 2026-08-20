/**
 * One place that turns a failure into something a user can act on.
 *
 * Every CLI surface used to render `err.message` and stop there, so a provider
 * rejection arrived as whatever the endpoint happened to say — often a JSON
 * body with no hint of which Proteus command fixes it. This module keeps the
 * provider's own words (they are the evidence) and appends the exact next
 * command for the failure class it recognises.
 *
 * It classifies the *message*, not an exception type: the same billing or
 * auth rejection reaches us as a thrown `APICallError` in one path and as a
 * streamed error event's text in another, and both deserve the same hint.
 */

import { describeProviderError } from '@kinu/core';

export type ProviderFailure = Parameters<typeof describeProviderError>[0];

export interface GuidedFailure {
  /** The failure in the provider's own words. Never empty —
   *  `describeProviderError` always resolves to something readable. */
  message: string;
  /** The next command to run, when the failure class implies one. */
  hint?: string;
}

const PROVIDER_LIST_HINT = 'See what is connected: proteus provider list';

/** Ordered because the classes overlap: an expired key is reported as a 401
 *  with billing words by some gateways, and the credential fix comes first. */
const CLASSES: ReadonlyArray<{ match: RegExp; hint: string }> = [
  {
    match: /\b(401|403)\b|unauthorized|forbidden|invalid[_ -]?api[_ -]?key|invalid[_ -]?token|authentication[_ -]?(failed|error)|expired[_ -]?token|no credential|not authenticated/i,
    hint: `The provider rejected the credential. Reconnect it: proteus provider connect <provider> — ${PROVIDER_LIST_HINT}`,
  },
  {
    match: /billing|insufficient[_ -]?quota|payment|credit balance|exceeded your current quota|account is not active/i,
    hint: `The provider account cannot serve requests (billing or quota). Fix it with the provider, or switch: proteus provider connect <provider> — ${PROVIDER_LIST_HINT}`,
  },
  {
    match: /model[_ -]?not[_ -]?found|does not exist|unknown model|no such model|unsupported[_ -]?model/i,
    hint: 'That model is not available on the connected provider. Pick another with /model in chat, or pass --model <provider>/<id>.',
  },
  {
    match: /\b429\b|rate[_ -]?limit|too many requests|overloaded/i,
    hint: 'The provider is rate-limiting this account. Retry shortly, or switch model with /model in chat.',
  },
  {
    match: /context[_ -]?length|too many tokens|maximum context|prompt is too long/i,
    hint: 'The turn exceeded the model context window. Start a fresh session, or choose a larger-context model with /model.',
  },
];

/**
 * Render any failure — a thrown value, or the already-stringified message a
 * stream `error` event carries — as `{message, hint}`. Errors that already
 * tell the user what to run (the "No LLM configured" family names its own
 * commands) keep their own wording rather than gaining a second, weaker hint.
 */
export function guideFailure(error: ProviderFailure): GuidedFailure {
  const message = describeProviderError(error);
  if (/proteus [a-z]/.test(message)) return { message };
  const matched = CLASSES.find((entry) => entry.match.test(message));
  return matched ? { message, hint: matched.hint } : { message };
}
