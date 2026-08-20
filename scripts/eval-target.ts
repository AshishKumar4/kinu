#!/usr/bin/env bun
// The target rule and the naming rule, for callers that are shell scripts.
//
//   AGENT_NAME="$(bun scripts/eval-target.ts "$BASE_URL" --name e2e-web)"
//
// Prints one `eval-…` workspace name on stdout when `origin` is a permitted eval
// target, and exits non-zero with the refusal on stderr when it is not. The
// caller uses the exit status; the name is the thing it needed anyway, so there
// is no way to take the name without passing the check.
//
// WHY IT EXISTS RATHER THAN A COPY OF THE RULE IN BASH. `scripts/e2e-web.sh`
// creates an agent on whatever it is pointed at, and a second opinion in shell
// about which hosts are production is a second thing to keep in step with
// `packages/test-utils/src/eval-identity.ts`. There is one allowlist and this is
// how a shell script reaches it.
import { evalTargetVerdict, evalWorkspaceName } from '../packages/test-utils/src/eval-identity';

const args = process.argv.slice(2);
const origin = args[0];
const nameFlag = args.indexOf('--name');
const subject = nameFlag === -1 ? undefined : args[nameFlag + 1];

if (!origin || !subject) {
  console.error('usage: eval-target.ts <origin> --name <subject>');
  process.exit(2);
}

const verdict = evalTargetVerdict(origin);
if (verdict.kind === 'refused') {
  console.error(`REFUSING: ${verdict.reason}`);
  process.exit(1);
}

console.error(`eval target: ${verdict.origin} (${verdict.why})`);
console.log(evalWorkspaceName(subject));
