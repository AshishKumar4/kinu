#!/usr/bin/env bun
// The deployment a tier drives, printed for its script: two lines on stdout, the origin, then the variable holding that
// deployment's DEV_IDENTITY_SECRET (`evalWebIdentityEnv`). With no argument the origin is the one `KINU_EVAL_ORIGIN`
// names, or the one default (`evalTargetVerdict`); with a wrangler environment's name, `production` or `staging`, it is
// the origin wrangler.jsonc declares for it (`deploymentOf`), as the evals' baseline leg asks. A target the allowlist
// refuses exits 1 with the reason on stderr, so no tier measures something else. The tiers export the origin as
// `KINU_EVAL_ORIGIN`; `KINU_ORIGIN` is only ever what `eval-credentials.ts` resolved, for the CLI and
// `resolveLiveModel`.
import * as v from 'valibot';
import { EVAL_IDENTITY_ENV, evalTargetVerdict, evalWebIdentityEnv } from '../packages/test-utils/src/eval-identity';
import { INFRA_ENVIRONMENTS, deploymentOf } from './infra-manifest';

const named = process.argv[2];

const environment = named === undefined ? undefined : v.parse(v.picklist(INFRA_ENVIRONMENTS), named);

const target = evalTargetVerdict(environment === undefined ? process.env[EVAL_IDENTITY_ENV.origin] : deploymentOf(environment).origin);

if (target.kind === 'refused') {
  console.error(target.reason);
  process.exit(1);
}

console.log(target.origin);

console.log(evalWebIdentityEnv(target.origin));
