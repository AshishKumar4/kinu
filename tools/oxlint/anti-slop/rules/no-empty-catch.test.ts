// Kinu-local rule; see upstream.json's `kinuRules`. There is no upstream suite beside this
// one. The repo-level corpus count and the seeded red->green run through the real `oxlint` binary
// live in ../no-swallow.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { noEmptyCatchRule } from "./no-empty-catch.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "emptyCatch" };

tester.run("anti-slop/no-empty-catch", noEmptyCatchRule, {
  valid: [
    "try { risky(); } catch (error) { log.warn('failed', { event: 'x.failed', error }); }",
    "try { risky(); } catch (error) { throw new Error('wrapped', { cause: error }); }",
    "try { risky(); } catch (error) { if (!expected(error)) throw error; }",
    // A bare rethrow is a statement; only a body with none at all is a discard.
    "try { risky(); } catch (error) { throw error; }",
    // try/finally with no handler has nothing to swallow.
    "try { risky(); } finally { release(); }",
    // An empty *try* is not this rule's business.
    "try { } catch (error) { report(error); }",
    "const noop = () => {};",
  ],
  invalid: [
    { name: "bare", code: "try { risky(); } catch {}", errors: [error] },
    { name: "bound but unused", code: "try { risky(); } catch (error) {}", errors: [error] },
    {
      name: "comment-only — the shape 167 sites use, and the part a model emits for free",
      code: "try { risky(); } catch { /* non-fatal */ }",
      errors: [error],
    },
    {
      name: "line comment",
      code: "try { risky(); } catch (error) {\n  // the table may not exist yet\n}",
      errors: [error],
    },
    {
      name: "still reported when a finalizer runs",
      code: "try { risky(); } catch {} finally { release(); }",
      errors: [error],
    },
    {
      name: "two independent swallows in one file",
      code: "try { a(); } catch {}\ntry { b(); } catch { /* also */ }",
      errors: [error, error],
    },
  ],
});
