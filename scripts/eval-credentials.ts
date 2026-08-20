#!/usr/bin/env bun
// The credential the eval tier runs on, printed for `scripts/eval-tier.sh`.
//
// Two lines on stdout — origin, then token — or NOTHING when no eval credential
// exists. Diagnostics go to stderr and never carry the token. Exits non-zero
// only when a credential names a target it may not reach; that is a refusal, not
// an absence, and the tier must stop rather than measure something else.
//
// WHAT THIS USED TO DO, AND WHY IT STOPPED. It read `~/.proteus/config.json` and
// promoted the OWNER'S SIGNED-IN SESSION to a live target, on the argument that
// the tier otherwise had no credential anywhere and reported `TOTAL: 0 model
// call(s)`. That fixed the false green and created a worse problem: an eval run
// and the owner working became the same event on the same account. Measured on
// 2026-08-20, production held 28 workspaces of which 23 were test debris — 22
// `drill*` rows and one `settle-probe` — and nothing on the account could say
// which harness had made any of them.
//
// So the credential is now the `eval-service` account's, read from the
// environment, and the rule about where it may point lives with it in
// `packages/test-utils/src/eval-identity.ts`. No session belonging to a person
// is ever borrowed. A machine with no eval credential skips every live suite,
// the skip-ratchet holds those skips accountable, and that is a result.
//
// WHY A SEPARATE PROCESS, still. `scripts/test-scratch-home.ts` strips the
// ambient credential variables at preload in every test process, so a resolver
// running inside a suite sees an empty environment no matter how correct it is.
// `eval-tier.sh` runs first and is already the consent boundary — it is the ONE
// place PROTEUS_EVAL_LIVE is set — so resolving the identity is the same
// decision, made in the same place.
import { resolveEvalIdentity } from '../packages/test-utils/src/eval-identity';

const resolved = resolveEvalIdentity();
if (resolved.kind === 'refused') {
  console.error(`eval-credentials: REFUSED — ${resolved.reason}`);
  process.exit(1);
}
if (resolved.kind === 'absent') {
  console.error(`eval-credentials: ${resolved.reason}`);
  process.exit(0);
}

console.error(`eval-credentials: running as ${resolved.identity.describe}`);
console.log(resolved.identity.origin);
console.log(resolved.identity.token);
