// Kinu-local coverage on top of the vendored upstream suite in ./no-runtime-typeof.test.ts.
// Pins the `objectInstanceof` check, which upstream has never carried at any commit.
// See tools/oxlint/anti-slop/upstream.json.
import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeofRule } from "./no-runtime-typeof.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "objectInstanceof" };

tester.run("anti-slop/no-runtime-typeof (Kinu-local)", noRuntimeTypeofRule, {
  valid: [
    "function check(Object: new () => Owner, value: Owner) { return value instanceof Object; }",
    "class Object {} const owned = value instanceof Object;",
    "const parsed = value instanceof Response;",
  ],
  invalid: [
    { code: "if (hint instanceof Object) use(hint);", errors: [error] },
    { code: "const isObject = (value: Owner) => value instanceof Object;", errors: [error] },
  ],
});
