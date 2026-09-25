import { RuleTester } from "oxlint/plugins-dev";

import { noDynamicModelImportRule } from "./no-dynamic-model-import.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/no-dynamic-model-import", noDynamicModelImportRule, {
  valid: [
    { code: "import type { LanguageModel } from 'ai';" },
    { code: "async function load() { return import('ai/test'); }" },
    { code: "async function load() { return import('./ai'); }" },
    { code: "async function load(specifier: string) { return import(specifier); }" },
  ],
  invalid: [
    {
      name: "a dynamic import of the SDK",
      code: "async function load() { const { generateText } = await import('ai'); return generateText; }",
      errors: [{ messageId: "dynamicModelImport", data: { how: "import" } }],
    },
    {
      name: "a dynamic import spelled as a template",
      code: "async function load() { return import(`ai`); }",
      errors: [{ messageId: "dynamicModelImport", data: { how: "import" } }],
    },
    {
      name: "a require of the SDK",
      code: "const { streamText } = require('ai');",
      errors: [{ messageId: "dynamicModelImport", data: { how: "require" } }],
    },
  ],
});
