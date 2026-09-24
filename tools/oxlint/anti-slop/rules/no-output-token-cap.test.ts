import { RuleTester } from "oxlint/plugins-dev";

import { noOutputTokenCapRule } from "./no-output-token-cap.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "outputCap" };
const product = "/repo/packages/core/src/chat.ts";

tester.run("anti-slop/no-output-token-cap", noOutputTokenCapRule, {
  valid: [
    { filename: product, code: "await generateText({ model, prompt, providerOptions });" },
    { filename: product, code: "const cap = model.limits.output;" },
    {
      filename: "/repo/packages/core/tests/unit-generate-json.test.ts",
      code: "expect(options.maxOutputTokens).toBeUndefined();",
    },
    { filename: "/repo/packages/core/src/skills/skills.test.ts", code: "await generateText({ model, maxOutputTokens: 16 });" },
  ],
  invalid: [
    { name: "call option", filename: product, code: "await streamText({ model, maxOutputTokens: 4096 });", errors: [error] },
    { name: "member read", filename: product, code: "const cap = options.maxOutputTokens;", errors: [error] },
    { name: "quoted key", filename: product, code: "const request = { 'maxOutputTokens': 1024 };", errors: [error] },
  ],
});
