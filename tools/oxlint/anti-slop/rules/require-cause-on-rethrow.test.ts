// Proteus-local rule; see upstream.json's `proteusRules`. Repo-level corpus count and the seeded
// red->green run through the real `oxlint` binary live in ../no-swallow.gate.test.ts.
import { RuleTester } from "oxlint/plugins-dev";

import { requireCauseOnRethrowRule } from "./require-cause-on-rethrow.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const missing = { messageId: "missingCause" };
const unbindable = { messageId: "unbindableCause" };

tester.run("anti-slop/require-cause-on-rethrow", requireCauseOnRethrowRule, {
  valid: [
    "try { g(); } catch (error) { throw new Error('failed', { cause: error }); }",
    "try { g(); } catch (error) { throw new Error('failed', { cause }); }",
    "try { g(); } catch (error) { throw new ProteusError('storage_unavailable', 'reading', { cause: error }); }",
    "try { g(); } catch (error) { throw new errors.WrappedError('failed', { cause: error }); }",
    // A bare rethrow preserves the chain by definition.
    "try { g(); } catch (error) { throw error; }",
    // Spread may carry a cause; this rule will not guess that it does not.
    "try { g(); } catch (error) { throw new Error('failed', { ...context }); }",
    // Outside a catch there is no chain to destroy.
    "function assertOwner(id: string) { if (!id) throw new Error('id required'); }",
    "throw new Error('boot failed');",
    // Not an error construction.
    "try { g(); } catch (error) { throw new Redirect('/login'); }",
    // A thrown non-construction expression.
    "try { g(); } catch (error) { throw toProteusError({ cause: error }); }",
  ],
  invalid: [
    {
      name: "the unwrapped-error mistake",
      code: "try { g(); } catch (error) { throw new Error('read failed'); }",
      errors: [missing],
    },
    {
      name: "message built from the error, chain still destroyed",
      code: "try { g(); } catch (error) { throw new Error(`read failed: ${String(error)}`); }",
      errors: [missing],
    },
    {
      name: "subclass without a cause",
      code: "try { g(); } catch (error) { throw new ProteusError('internal', 'reading'); }",
      errors: [missing],
    },
    {
      name: "namespaced subclass without a cause",
      code: "try { g(); } catch (error) { throw new errors.WrappedError('failed'); }",
      errors: [missing],
    },
    {
      name: "a present-but-empty cause reads as a chain and carries nothing",
      code: "try { g(); } catch (error) { throw new Error('failed', { cause: undefined }); }",
      errors: [missing],
    },
    {
      name: "explicit null cause",
      code: "try { g(); } catch (error) { throw new Error('failed', { cause: null }); }",
      errors: [missing],
    },
    {
      name: "no binding, so no cause is reachable — bind it",
      code: "try { g(); } catch { throw new Error('read failed'); }",
      errors: [unbindable],
    },
    {
      name: "nested in a block inside the catch",
      code: "try { g(); } catch (error) { if (fatal(error)) { throw new Error('fatal'); } }",
      errors: [missing],
    },
    {
      name: "inside a callback defined in the catch — the binding is still in scope",
      code: "try { g(); } catch (error) { items.forEach(() => { throw new Error('failed'); }); }",
      errors: [missing],
    },
    {
      name: "two throws in one catch",
      code: "try { g(); } catch (error) { if (a) throw new Error('a'); throw new Error('b'); }",
      errors: [missing, missing],
    },
    // Two independent files' worth of code in one corpus entry: this rule resolves the enclosing
    // catch by walking parents rather than keeping a stack, so it holds no state that could leak
    // between files in a reused `createOnce` visitor.
    {
      name: "a throw outside any catch does not inherit a previous catch's verdict",
      code: "try { g(); } catch (error) { throw new Error('inside'); }\nfunction later() { throw new Error('outside'); }",
      errors: [missing],
    },
  ],
});
