import { RuleTester } from "oxlint/plugins-dev";
import { modelMethodBoundaryRule } from "./model-method-boundary.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const filename = "/repo/packages/core/src/model.ts";

tester.run("anti-slop/model-method-boundary", modelMethodBoundaryRule, {
  valid: [
    { code: "wrapLanguageModel({ model, middleware: { wrapStream: async ({ doStream }) => doStream() } });" },
    { code: "wrapLanguageModel({ model, middleware: { async wrapGenerate({ doGenerate: generate }) { return generate(); } } });" },
    { code: "const middleware = { wrapStream: async ({ doGenerate }) => doGenerate() };" },
    { code: "const model = { specificationVersion: 'v4', async doStream(options) { return original.doStream(options); } };" },
    { code: "class Model { specificationVersion = 'v4' as const; async doGenerate(options) { return original.doGenerate(options); } }" },
    { code: "await streamTextReported({ model, messages }, spend);" },
    { code: "import { MockLanguageModelV4 } from 'ai/test'; function model(config: { doGenerate(): unknown }): MockLanguageModelV4 { const { doGenerate } = config; return new MockLanguageModelV4({ doGenerate }); }" },
  ].map((entry) => ({ ...entry, filename })),
  invalid: [
    { code: "await model.doStream(options);", errors: [{ messageId: "outsideBoundary" }] },
    { code: "await model['doGenerate'](options);", errors: [{ messageId: "outsideBoundary" }] },
    { code: "const { doStream: invoke } = model; invoke(options);", errors: [{ messageId: "outsideBoundary" }] },
    { code: "const { 'doGenerate': invoke } = model; invoke(options);", errors: [{ messageId: "outsideBoundary" }] },
    { code: "async function invoke({ doStream }) { return doStream(); }", errors: [{ messageId: "outsideBoundary" }] },
    { code: "function model(config: { doGenerate(): unknown }): unknown { const { doGenerate } = config; return doGenerate(); }", errors: [{ messageId: "outsideBoundary" }] },
    { code: "const middleware = { wrapStream: async ({ model }) => model.doStream(options) };", errors: [{ messageId: "outsideBoundary" }] },
    { code: "const model = { async doStream(options) { return original.doStream(options); } };", errors: [{ messageId: "outsideBoundary" }] },
    { code: "const model = { specificationVersion: 'v4', async doStream(options) { return (() => original.doStream(options))(); } };", errors: [{ messageId: "outsideBoundary" }] },
  ].map((entry) => ({ ...entry, filename })),
});
