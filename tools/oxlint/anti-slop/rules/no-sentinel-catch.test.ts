// Proteus-local rule; see upstream.json's `proteusRules`. The repo-level corpus count and the
// seeded red->green run through the real `oxlint` binary live in ../no-swallow.gate.test.ts,
// including the historical `workspace_capability` read this rule exists for.
import { RuleTester } from "oxlint/plugins-dev";

import { noSentinelCatchRule } from "./no-sentinel-catch.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const inCatch = { messageId: "sentinelCatch" };
const inHandler = { messageId: "sentinelRejectionHandler" };

tester.run("anti-slop/no-sentinel-catch", noSentinelCatchRule, {
  valid: [
    // The escape, and the whole point of the rule: say which failure you tolerate.
    "function read() { try { return get(); } catch (error) { if (!isMissingTable(error)) throw error; return null; } }",
    // Record, then return a value the caller can tell apart.
    "function read() { try { return get(); } catch (error) { log.warn('read failed', { event: 'x.read_failed', error }); return null; } }",
    "function read() { try { return get(); } catch (error) { throw new Error('read failed', { cause: error }); } }",
    // A non-sentinel return distinguishes failure from success by itself.
    "function read() { try { return get(); } catch (error) { return { ok: false, error }; } }",
    "function read() { try { return get(); } catch (error) { return err(toProteusError({ cause: error })); } }",
    // An empty body is no-empty-catch's finding; this rule must not double-report it.
    "try { risky(); } catch {}",
    // Rejection handlers that do something.
    "load().catch((error) => log.warn('load failed', { event: 'x.load_failed', error }));",
    "load().catch((error) => { throw new Error('load failed', { cause: error }); });",
    "load().catch(reportLoadFailure);",
    // `catch` with two arguments is not a promise rejection handler shape we recognise.
    "shim.catch(() => null, extra);",
    // Not a sentinel.
    "function read() { try { return get(); } catch (error) { return -1; } }",
    "function read() { try { return get(); } catch (error) { return { retry: true }; } }",
  ],
  invalid: [
    {
      name: "the workspace_capability shape — null for absent and null for broken",
      code: "async function token() { try { ensureTable(); return rows()[0]?.token || null; } catch { return null; } }",
      errors: [inCatch],
    },
    { name: "undefined", code: "function f() { try { g(); } catch { return undefined; } }", errors: [inCatch] },
    { name: "bare return", code: "function f() { try { g(); } catch { return; } }", errors: [inCatch] },
    { name: "empty array", code: "function f() { try { g(); } catch { return []; } }", errors: [inCatch] },
    { name: "empty object", code: "function f() { try { g(); } catch { return {}; } }", errors: [inCatch] },
    { name: "false", code: "function f() { try { g(); } catch { return false; } }", errors: [inCatch] },
    { name: "zero", code: "function f() { try { g(); } catch { return 0; } }", errors: [inCatch] },
    { name: "empty string", code: "function f() { try { g(); } catch { return ''; } }", errors: [inCatch] },
    {
      name: "empty template literal",
      code: "function f() { try { g(); } catch { return ``; } }",
      errors: [inCatch],
    },
    { name: "void 0", code: "function f() { try { g(); } catch { return void 0; } }", errors: [inCatch] },
    {
      name: "an assertion does not launder the sentinel",
      code: "function f() { try { g(); } catch { return null as Token | null; } }",
      errors: [inCatch],
    },
    {
      name: "bound error, still discarded",
      code: "function f() { try { g(); } catch (error) { return []; } }",
      errors: [inCatch],
    },
    // The promise spelling. Leaving it uncovered would make it the cheap way around the rule.
    { name: "arrow expression body", code: "const v = await load().catch(() => null);", errors: [inHandler] },
    { name: "arrow with argument", code: "const v = await load().catch((error) => undefined);", errors: [inHandler] },
    { name: "arrow empty block", code: "await load().catch(() => {});", errors: [inHandler] },
    {
      name: "arrow block returning sentinel",
      code: "const v = await load().catch((error) => { return []; });",
      errors: [inHandler],
    },
    { name: "async arrow", code: "const v = await load().catch(async () => null);", errors: [inHandler] },
    {
      name: "function expression",
      code: "const v = await load().catch(function () { return false; });",
      errors: [inHandler],
    },
    { name: "computed member", code: "const v = await load()['catch'](() => null);", errors: [inHandler] },
    {
      name: "both spellings in one file",
      code: "function f() { try { g(); } catch { return null; } }\nconst v = load().catch(() => []);",
      errors: [inCatch, inHandler],
    },
  ],
});
