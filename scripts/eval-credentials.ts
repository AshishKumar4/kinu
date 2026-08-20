#!/usr/bin/env bun
// The live-model credential the eval tier should use, printed for `scripts/eval-tier.sh`.
//
// Two lines on stdout — origin, then token — or NOTHING when the environment
// already names a target or no signed-in session exists. Diagnostics go to
// stderr and never carry the token.
//
// WHY A SEPARATE PROCESS. The resolution has to happen BEFORE `bun test`, and
// that is not a preference: `scripts/test-scratch-home.ts` overwrites
// PROTEUS_HOME with a throwaway directory at preload in every test process, so a
// resolver running inside a suite reads an empty config and finds no credential
// no matter how correct it is. `eval-tier.sh` runs first and is already the
// consent boundary — it is the ONE place PROTEUS_EVAL_LIVE is set — so promoting
// the owner's stored session to a live target is the same decision, made in the
// same place.
//
// The precedence rule is `liveModelFallback`, tested next to the resolver it
// completes. Whether a session exists at all is the CLI's own question, answered
// by the CLI's own reader, so an expired session is refused here exactly as it is
// by `kinu chat`.
import { liveModelFallback } from '../packages/test-utils/src/live-model';
import { resolveCloudSession } from '../packages/cli/src/config';

const fallback = liveModelFallback(resolveCloudSession());
if (!fallback) {
  console.error('eval-credentials: no signed-in CLI session to borrow, or the environment already names a target');
  process.exit(0);
}

console.error(`eval-credentials: borrowing the signed-in CLI session for ${fallback.origin}`);
console.log(fallback.origin);
console.log(fallback.token);
