// Proteus-local coverage on top of the vendored upstream suite in ./no-unknown-type-aliases.test.ts.
// Pins that an `unknown` member inside an object type is not an alias to `unknown`, which is the
// carve-out the codebase relies on for error causes.
import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownTypeAliasesRule } from "./no-unknown-type-aliases.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-unknown-type-aliases (Proteus-local)", noUnknownTypeAliasesRule, {
  valid: ["type Result = { cause: unknown };", "type Failure = { readonly causes: unknown[] };"],
  invalid: [{ code: "type Raw = (unknown);", errors: [{ messageId: "unknownAlias" }] }],
});
