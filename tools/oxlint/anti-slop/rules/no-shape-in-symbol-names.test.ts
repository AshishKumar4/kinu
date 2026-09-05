// Kinu-authored: upstream ships no test for this rule. The invalid cases pin the
// case-insensitive substring ban; a previous session narrowed it to a lexical-word ban and hid 30
// real violations (recorded 2026-08-17), so these cases exist to make that narrowing fail loudly.
import { RuleTester } from "oxlint/plugins-dev";

import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "forbiddenSymbolName" };

tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
  valid: ["const resizeImage = (value: Image) => value;", "interface Geometry {}"],
  invalid: [
    { code: "interface UserShape {}", errors: [error] },
    { code: "const payload_shape = {};", errors: [error] },
    { code: "const reshapeImage = (value: Image) => value;", errors: [error] },
    { code: "interface ShapelessGeometry {}", errors: [error] },
  ],
});
