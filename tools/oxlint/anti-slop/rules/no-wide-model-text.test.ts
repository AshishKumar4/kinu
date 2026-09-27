// Kinu-local rule; see upstream.json's `kinuRules`. The seeded red->green through the real `oxlint` binary is in
// ../no-design-smells.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { noWideModelTextRule } from "./no-wide-model-text.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const tool = "/repo/packages/core/src/tools/memory-tool.ts";
const wide = { messageId: "wide" };

tester.run("anti-slop/no-wide-model-text", noWideModelTextRule, {
  valid: [
    { filename: tool, code: "export const description = 'Remember a fact: key, value, and why it matters.';" },
    // Latin-1 stays one byte per character in V8.
    { filename: tool, code: "export const name = 'café';" },
    // An escape marks the character as data, such as a byte-order mark to strip.
    { filename: tool, code: "export const BOM = '\\uFEFF';" },
    // A comment reaches no model.
    { filename: tool, code: "// A dash — in a comment\nexport const x = 'plain';" },
    // Outside the model-facing roots, and in tests, the rule has nothing to say.
    { filename: "/repo/packages/cli/src/tui/panes.tsx", code: "export const bullet = '•';" },
    { filename: "/repo/packages/core/src/tools/memory-tool.test.ts", code: "expect(text).toContain('a — b');" },
  ],
  invalid: [
    { name: "an em dash in a tool description", filename: tool, code: "export const d = 'Search docs — fast.';", errors: [wide] },
    { name: "an arrow in a template", filename: "/repo/packages/core/src/skills/render.ts", code: "export const line = (n: string) => `${n} → read it`;", errors: [wide] },
    { name: "an ellipsis in compaction", filename: "/repo/packages/core/src/compaction.ts", code: "export const cut = '…';", errors: [wide] },
    { name: "a log line in a head", filename: "/repo/packages/core/src/heads/controller.ts", code: "log('head done — merging');", errors: [wide] },
  ],
});
