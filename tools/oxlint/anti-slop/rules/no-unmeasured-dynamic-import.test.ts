import { RuleTester } from "oxlint/plugins-dev";

import { noUnmeasuredDynamicImportRule } from "./no-unmeasured-dynamic-import.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const worker = "/repo/packages/cf-backend/src/user/routes.ts";

tester.run("anti-slop/no-unmeasured-dynamic-import", noUnmeasuredDynamicImportRule, {
  valid: [
    {
      name: "a loader citing the armada run that measured it",
      filename: worker,
      code: "// Imported by its route: used heap 25.6 to 24.4 MB (armada 20261007213937-cdf08921).\nconst webauthn = () => import('@simplewebauthn/server');",
    },
    {
      name: "a declaration's doc citing the commit whose body measured it",
      filename: worker,
      code: "/** Loaded at the first MCP request: the startup closure 6,981 to 6,533 KiB (12d8c7440). */\nexport async function answer() {\n  const { answerMcp } = await import('./mcp-tools');\n  return answerMcp;\n}",
    },
    {
      name: "a decision-log entry that holds the measurement",
      filename: "/repo/packages/core/src/x.ts",
      code: "class Host {\n  /** Most of every isolate's startup (L27). */\n  load() { return import('./host'); }\n}",
    },
    {
      name: "the browser's React tree splits its chunks without one",
      filename: "/repo/packages/cf-backend/src/components/surfaces/WorkSurface.ts",
      code: "export const surface = async () => (await import('./FilesSurface')).FilesSurface;",
    },
    {
      name: "a browser hook",
      filename: "/repo/packages/cf-backend/src/hooks/use-element-size.ts",
      code: "export const measure = () => import('./measure');",
    },
    {
      name: "a component file",
      filename: "/repo/packages/cf-backend/src/App.tsx",
      code: "const Page = lazy(() => import('./pages/Page'));",
    },
    {
      name: "the CLI, which the Worker does not deploy",
      filename: "/repo/packages/cli-backend/src/runtime.ts",
      code: "export const load = () => import('./heavy');",
    },
    {
      name: "generated source holds the word, not the expression",
      filename: worker,
      code: "export const source = 'const kinu = await import(\"./kinu-node.js\");';",
    },
  ],
  invalid: [
    {
      name: "an inline import of a sibling, with no measurement",
      filename: worker,
      code: "export async function classify(error: Error) {\n  const { classifyMcpFailure } = await import('./mcp');\n  return classifyMcpFailure(error);\n}",
      errors: [{ messageId: "unmeasuredDynamicImport" }],
    },
    {
      name: "the devbox gateway the Worker exports",
      filename: "/repo/packages/devbox/src/gateway.ts",
      code: "export const load = () => import('./session');",
      errors: [{ messageId: "unmeasuredDynamicImport" }],
    },
    {
      name: "a reason that is not a measurement",
      filename: "/repo/packages/core/src/egress.ts",
      code: "// Lazy so the test can mock the module first.\nconst sockets = () => import('cloudflare:sockets');",
      errors: [{ messageId: "unmeasuredDynamicImport" }],
    },
    {
      name: "a citation after the import does not cover it",
      filename: worker,
      code: "const load = () => import('./x'); // armada 20261007213937-cdf08921",
      errors: [{ messageId: "unmeasuredDynamicImport" }],
    },
    {
      name: "a hex-looking word is not a commit",
      filename: "/repo/packages/agent-utils/src/x.ts",
      code: "// The deadbeefcafe build.\nconst load = () => import('./x');",
      errors: [{ messageId: "unmeasuredDynamicImport" }],
    },
  ],
});
