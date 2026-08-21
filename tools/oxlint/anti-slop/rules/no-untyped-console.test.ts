import { RuleTester } from "oxlint/plugins-dev";

import { noUntypedConsoleRule } from "./no-untyped-console.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "untypedConsole" };

// The rule is scoped by filename, so every case has to be given one. A case with no `filename` is
// linted as an out-of-scope file and is valid by construction, which would make the suite vacuous.
const core = "packages/core/src/heads/controller.ts";
const cf = "packages/cf-backend/src/orchestrator.ts";
const cliBackend = "packages/cli-backend/src/local-session.ts";

tester.run("anti-slop/no-untyped-console", noUntypedConsoleRule, {
  valid: [
    // ── The boundary. `packages/cli/src` is the product's terminal UI: 479 chalk-styled writes to a
    // stream a human is reading. Converting them would replace a rendered table with JSON.
    { code: "console.log(OK('done'));", filename: "packages/cli/src/display.ts" },
    { code: "console.error(`${ERR('error')} ${message}`);", filename: "packages/cli/src/chat-loop.ts" },
    { code: "console.log(table);", filename: "packages/cli/src/commands/status.ts" },
    // The typed logger's own emitter, which must reach `console` for anything to be logged at all.
    { code: "console.log(JSON.stringify(line));", filename: "packages/core/src/obs/log.ts" },
    { code: "console.error(JSON.stringify(line));", filename: "packages/core/src/obs/log.ts" },
    // The browser half of the cf-backend bundle: a React console is a developer artefact reaching
    // neither Workers Logs nor the daemon journal.
    { code: "console.error(`[ErrorBoundary]`, error, info.componentStack);", filename: "packages/cf-backend/src/components/ErrorBoundary.tsx" },
    { code: "console.warn('[sidebar] listWorkspaces:', err.message);", filename: "packages/cf-backend/src/components/Sidebar.tsx" },
    // Standalone plain JavaScript with no build and no @kinu.run/core dependency.
    { code: "console.log(new Date().toISOString(), ...a);", filename: "packages/pc-agent/src/index.js" },
    // Outside `packages/<pkg>/src` entirely: a gate script printing its findings is doing its job.
    { code: "console.log(`tracing: ok — ${measured}`);", filename: "scripts/tracing-gate.ts" },
    { code: "console.error(entry);", filename: "packages/cf-backend/tests/workerd/worker.ts" },
    { code: "console.log(rows);", filename: "packages/test-utils/src/scratch.ts" },
    // ── The remedy, in both forms.
    {
      code: "diagnostics.failure('head.score_failed', toKinuError({ doing: 'scoring a head', cause: err, otherwise: 'unavailable' }), { headId });",
      filename: core,
    },
    { code: "diagnostics.event('sandbox.executor_registered', { transport: 'websocket' });", filename: cf },
    { code: "logger.failure('run.escalation_denied', refusal, { runtime });", filename: core },
    // A `console` that is not the receiver at all.
    { code: "reporters.console.write('x');", filename: core },
    { code: "obj.console.log('x');", filename: core },
    { code: "record({ console: 1 });", filename: core },
  ],
  invalid: [
    // The exact shape the 650-site census found, in each tree the rule covers.
    {
      code: "console.warn('[kinu] head could not be scored:', outcome.reason);",
      filename: core,
      errors: [error],
    },
    {
      code: "console.error('[kinu] alarm handler failed:', err instanceof Error ? err.message : String(err));",
      filename: cf,
      errors: [error],
    },
    {
      code: "console.warn(`[kinu] ${message}`);",
      filename: cliBackend,
      errors: [error],
    },
    // Every method, not just the four the census happened to find: `debug`, `info`, `trace`, `table`
    // and `dir` are equally unqueryable.
    { code: "console.log(x);", filename: core, errors: [error] },
    { code: "console.info(x);", filename: core, errors: [error] },
    { code: "console.debug(x);", filename: core, errors: [error] },
    { code: "console.trace(x);", filename: core, errors: [error] },
    { code: "console.table(rows);", filename: core, errors: [error] },
    // The computed spelling of the same call.
    { code: "console['warn'](x);", filename: core, errors: [error] },
    // The trees already at zero are in scope to KEEP them there.
    { code: "console.warn(x);", filename: "packages/agent-utils/src/vfs/encoding.ts", errors: [error] },
    { code: "console.warn(x);", filename: "packages/compaction/src/index.ts", errors: [error] },
    // A sibling of an allowlisted file is not allowlisted: the entry names a file, not its directory.
    { code: "console.log(x);", filename: "packages/core/src/obs/tracer.ts", errors: [error] },
    { code: "console.log(x);", filename: "packages/cli-backend/src/runtime.ts", errors: [error] },
    // `executor.ts` is NOT allowlisted: its `{ok,result}` protocol writes live inside a template
    // literal this rule's AST never sees, so a bare call there is a real diagnostic and a real finding.
    { code: "console.log(x);", filename: "packages/cli-backend/src/executor.ts", errors: [error] },
    // Two calls, two findings.
    { code: "console.warn(a);\nconsole.error(b);", filename: core, errors: [error, error] },
    // KNOWN OVER-REPORT, recorded rather than rediscovered: the matcher is the identifier NAME, so a
    // local binding that shadows the global is reported too. Resolving it needs scope analysis, and
    // the shape does not occur — a local named `console` in a runtime package would be a worse
    // problem than the one this rule is about.
    { code: "const console = makeReporter();\nconsole.report('x');", filename: core, errors: [error] },
  ],
});
