// What model something gets when nobody named one.
//
// Both backends answer this, and they answered it differently — one chose among
// what the account can actually serve, the other derived a provider for a bare
// id from local endpoint configuration. Those are two different questions, and
// only the first is shared policy; the second depends on adapter state (a local
// endpoint, a registry, the set of proxied provider ids) that core has no
// business reading. So this module owns exactly the shared half.
//
// The product COPY for a refusal stays per backend: "Cloudflare Workers AI is
// not connected. Reconnect…" and "No default model configured. Run kinu auth…"
// name different remedies on different surfaces, and merging them would make
// one of them wrong. A null return says there is no honest answer; the caller
// says what to do about it.

import { DEFAULT_WORKERS_AI_MODEL_SPEC } from './workers-ai';

/**
 * The model to start on, given what is actually available.
 *
 * An explicit or configured choice wins, but ONLY if the account can serve it —
 * a stored default naming a provider whose key was since revoked is not an
 * answer, it is a turn that fails on its first call.
 *
 * With no usable choice, the native Workers AI default is the only automatic
 * answer, and only when it is itself available. Falling through to whatever
 * happened to be FIRST in the menu is the one thing this must never do: it
 * silently signed new workspaces up to a paid BYO provider, which is why the
 * absence of that fallback is pinned by test rather than left to be re-derived
 * by the next reader who thinks a null looks unfinished.
 */
export function defaultSpecFor(
  configured: string | null | undefined,
  availableSpecs: readonly string[],
): string | null {
  if (configured && availableSpecs.includes(configured)) return configured;
  return availableSpecs.includes(DEFAULT_WORKERS_AI_MODEL_SPEC)
    ? DEFAULT_WORKERS_AI_MODEL_SPEC
    : null;
}
