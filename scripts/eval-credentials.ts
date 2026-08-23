#!/usr/bin/env bun
// The credential the eval tier runs on, printed for `scripts/eval-tier.sh`.
//
// Two lines on stdout — origin, then token — or NOTHING when no eval credential
// exists. Diagnostics go to stderr and never carry the token. Exits non-zero
// only when a credential names a target it may not reach; that is a refusal, not
// an absence, and the tier must stop rather than measure something else.
//
// WHAT THIS USED TO DO, AND WHY IT STOPPED. It read `~/.kinu/config.json` and
// promoted the OWNER'S SIGNED-IN SESSION to a live target, on the argument that
// the tier otherwise had no credential anywhere and reported `TOTAL: 0 model
// call(s)`. That fixed the false green and created a worse problem: an eval run
// and the owner working became the same event on the same account. Measured on
// 2026-08-20, production held 28 workspaces of which 23 were test debris — 22
// `drill*` rows and one `settle-probe` — and nothing on the account could say
// which harness had made any of them.
//
// The credential belongs to the `eval-service` account. It comes from the
// environment or the isolated `~/.config/kinu/eval-session/config.json`, never
// from the person's normal Kinu config. The endpoint allowlist remains in
// `packages/test-utils/src/eval-identity.ts`.
//
// WHY A SEPARATE PROCESS, still. `scripts/test-scratch-home.ts` strips the
// ambient credential variables at preload in every test process, so a resolver
// running inside a suite sees an empty environment no matter how correct it is.
// `eval-tier.sh` runs first and is already the consent boundary — it is the ONE
// place KINU_EVAL_LIVE is set — so resolving the identity is the same
// decision, made in the same place.
//
// IT ALSO RULES ON THE MODEL ENDPOINT, because a target can arrive by a second
// door. `KINU_BASE_URL` / `AI_GATEWAY_BASE_URL` carry a whole base URL, and one
// of those can be a deployment's own inference route rather than a gateway:
// `resolveLLMConfig` turns `https://kinu.run/api/user/ai/v1` plus a bearer into
// an `Authorization` header, which is what production accepts, and
// `resolveLiveModel` calls the same URL an `ai-gateway` target. Both then take
// precedence over whatever this script resolved. So the endpoint is ruled on
// here, by the same allowlist, before an origin is printed.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  EVAL_IDENTITY_ENV,
  refusedEvalEndpoint,
  resolveEvalIdentity,
} from '../packages/test-utils/src/eval-identity';
import * as v from 'valibot';

const PersistedEvalIdentitySchema = v.object({
  origin: v.string(),
  accessToken: v.string(),
});
const persistedPath = `${homedir()}/.config/kinu/eval-session/config.json`;
const identityEnv: NodeJS.ProcessEnv = { ...process.env };
if (!identityEnv[EVAL_IDENTITY_ENV.token] && existsSync(persistedPath)) {
  const permissions = statSync(persistedPath).mode & 0o077;
  if (permissions !== 0) {
    console.error(`eval-credentials: REFUSED — ${persistedPath} must be mode 0600`);
    process.exit(1);
  }
  const persisted = v.parse(
    PersistedEvalIdentitySchema,
    JSON.parse(readFileSync(persistedPath, 'utf8')),
  );
  identityEnv[EVAL_IDENTITY_ENV.origin] = persisted.origin;
  identityEnv[EVAL_IDENTITY_ENV.token] = persisted.accessToken;
}

const endpoint = refusedEvalEndpoint();
if (endpoint) {
  console.error(`eval-credentials: REFUSED — ${endpoint.variable} names a deployment: ${endpoint.reason}`);
  process.exit(1);
}

const resolved = resolveEvalIdentity(identityEnv);
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
