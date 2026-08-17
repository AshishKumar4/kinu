// Proteus-authored: upstream ships no test for this rule.
import { RuleTester } from "oxlint/plugins-dev";

import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "chained" };

tester.run("anti-slop/no-chained-type-assertions", noChainedTypeAssertionsRule, {
  valid: ["const values = [1, 2] as const;", "const user = input as User;"],
  invalid: [
    { code: "const user = (input as unknown) as User;", errors: [error] },
    { code: "const user = input as unknown as User;", errors: [error] },
    { code: "const user = <User>(<unknown>input);", errors: [error] },
  ],
});
