import { RuleTester } from "oxlint/plugins-dev";

import { noCliCredentialFlagRule } from "./no-cli-credential-flag.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-cli-credential-flag", noCliCredentialFlagRule, {
  valid: [
    // Through stdin, as `wrangler secret put` reads it.
    { code: "execFileSync('bunx', ['wrangler', 'secret', 'put', name], { input: `${value}\\n` });" },
    // Through the child's environment.
    { code: "spawn('aws', ['s3', 'ls'], { env: { ...process.env, AWS_ACCESS_KEY_ID: key } });" },
    { code: "const note = 'rotate the access key id monthly';" },
  ],
  invalid: [
    {
      name: "a credential flag in an argv array",
      code: "execFileSync('aws', ['configure', '--access-key-id', key]);",
      errors: [{ messageId: "credentialFlag", data: { flag: "--access-key-id" } }],
    },
    {
      name: "a flag with its value in one string",
      code: "const argv = ['r2', `--secret-access-key=${secret}`];",
      errors: [{ messageId: "credentialFlag", data: { flag: "--secret-access-key" } }],
    },
    {
      name: "a flag inside a shell line",
      code: "run('aws sts get-caller-identity --session-token ' + token);",
      errors: [{ messageId: "credentialFlag", data: { flag: "--session-token" } }],
    },
  ],
});
