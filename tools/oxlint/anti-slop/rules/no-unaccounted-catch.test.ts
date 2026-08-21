// Proteus-local rule; see upstream.json's `proteusRules`. The repo-level corpus count and the
// seeded red->green run through the real `oxlint` binary live in ../no-swallow.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { noUnaccountedCatchRule } from "./no-unaccounted-catch.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const unaccounted = { messageId: "unaccountedCatch" };

tester.run("anti-slop/no-unaccounted-catch", noUnaccountedCatchRule, {
  valid: [
    // The three doctrine shapes, each silent here because another rule already polices its
    // finer points (require-cause-on-rethrow the wrap, no-ddl-in-catch the DDL handler).
    "function read() { try { return get(); } catch (error) { throw error; } }",
    "function read() { try { return get(); } catch (error) { throw new Error('read failed', { cause: error }); } }",
    "function read() { try { return get(); } catch (error) { log.warn('read failed', { event: 'x.read_failed', error }); return null; } }",
    "function read() { try { return get(); } catch (error) { diagnostics.failure('x.read_failed', toKinuError({ doing: 'read', cause: error, otherwise: 'io' })); } }",
    // Classify the tolerated failure and rethrow everything else — the guard's throw is what
    // this rule reads, exactly as no-sentinel-catch does.
    "function read() { try { return get(); } catch (error) { if (!isMissingTable(error)) throw error; return null; } }",
    "function read() { try { return get(); } catch (error) { if (classify({ cause: error }) === null) throw error; return undefined; } }",
    // Handing the caught value to the caller is handle-and-say-so — the family convention
    // no-sentinel-catch already accepts for `{ ok: false, error }`.
    "function read() { try { return get(); } catch (error) { return { ok: false, error }; } }",
    "function deliver() { try { return route(); } catch (error) { return { delivered: false, detail: renderThrownChain({ cause: error }) }; } }",
    // A recording sink by any of its spellings.
    "function read() { try { return get(); } catch (error) { logger.failure('x.read_failed', error); } }",
    "function step() { try { advance(); } catch (error) { this.logActivity('step_failed', { error }); } }",
    // An empty body is no-empty-catch's finding; a sentinel return is no-sentinel-catch's.
    // This rule must not double-report what a sibling already owns.
    "try { risky(); } catch {}",
    "try { risky(); } catch { return null; }",
  ],
  invalid: [
    {
      name: "computed fallback — Array.from",
      code: "function read() { try { return readdir(dir); } catch { return Array.from(byName.values()); } }",
      errors: [unaccounted],
    },
    {
      name: "spread fallback",
      code: "async function label() { try { titles = parse(await done()); } catch { return [...clusters]; } }",
      errors: [unaccounted],
    },
    {
      name: "assignment fallback",
      code: "function rows() { try { return query(); } catch { rows = []; } }",
      errors: [unaccounted],
    },
    {
      name: "continue past the failure",
      code: "async function drain(cmds) { for (const c of cmds) { try { out.push(await exec(c)); } catch { continue; } } }",
      errors: [unaccounted],
    },
    {
      name: "String coercion fallback",
      code: "function render(v) { try { return JSON.stringify(v); } catch { return String(v); } }",
      errors: [unaccounted],
    },
    {
      name: "non-empty literal object hides the drop",
      code: "function dismiss() { try { jobs.dismiss(id); return { ok: true }; } catch { return { ok: false }; } }",
      errors: [unaccounted],
    },
    {
      name: "identity return of the raw input",
      code: "function parse(json) { try { return parseJsonValue(json); } catch { return json; } }",
      errors: [unaccounted],
    },
    {
      name: "a call that neither classifies nor records changes nothing",
      code: "function reset() { try { return load(); } catch { store.reset(); } }",
      errors: [unaccounted],
    },
    {
      name: "binding the error without using it is still a drop",
      code: "async function probe(cmds) { for (const c of cmds) { try { run(c); } catch (error) { continue; } } }",
      errors: [unaccounted],
    },
    {
      name: "the caught value coerced without reaching an observer",
      code: "function digest(input) { try { return project(input); } catch { return String(input.value).slice(0, 8); } }",
      errors: [unaccounted],
    },
  ],
});
