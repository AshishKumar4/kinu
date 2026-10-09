// Kinu-local rule; see upstream.json's `kinuRules`. The planted red->green through the real `oxlint` binary and the
// live tree's zero findings are in ../no-module-scope-flight.gate.test.ts.
//
// Why: a flight at module scope joins every request on a Worker isolate to a read one request started, and a
// cancelled request's dropped subrequest leaves it unsettled for good (workerd 2026-09-30; staging d930f2537).
import { RuleTester } from "oxlint/plugins-dev";

import { noModuleScopeFlightRule } from "./no-module-scope-flight.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "moduleFlight" };

// The rule is scoped by filename: shipped source only.
const core = "packages/core/src/providers/models-dev.ts";

tester.run("anti-slop/no-module-scope-flight", noModuleScopeFlightRule, {
  valid: [
    // A Durable Object instance's own flight, and a call's.
    { code: "class Host { private readonly homes = flight((id: string) => open(id)); }", filename: core },
    { code: "export function transport() { const refresh = flight(() => read()); return refresh; }", filename: core },
    { code: "export const make = () => flight(() => read());", filename: core },
    // Settled data at module scope.
    { code: "let cache: { readonly data: Catalog } | null = null;", filename: core },
    { code: "const derived = new Map<string, Promise<string>>();", filename: core },
    // Outside shipped source.
    { code: "const reads = flight(() => read());", filename: "scripts/tool.ts" },
    { code: "const reads = flight(() => read());", filename: "packages/core/tests/unit-x.test.ts" },
  ],
  invalid: [
    {
      name: "models-dev.ts as it stood at d930f2537: a module-scope map of flights by fetch function",
      code: "const reads = new WeakMap<typeof fetch, Flight<void, Record<string, ModelsDevProvider>, KinuError>>();",
      filename: core,
      errors: [error],
    },
    { name: "a flight made at module scope", code: "export const catalog = flight(() => readCatalog());", filename: core, errors: [error] },
    { name: "a module-scope binding typed as a flight", code: "let reading: Flight<void, Catalog, KinuError> | undefined;", filename: core, errors: [error] },
    { name: "a static class field is module scope", code: "class Catalog { static reading = flight(() => read()); }", filename: core, errors: [error] },
  ],
});
