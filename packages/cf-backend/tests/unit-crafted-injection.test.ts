// Regression tests for the preamble injection policy.
//
// PreambleCraftedExecutor used to inject EVERY non-comment crafted tool via a
// raw craftStore.list(), bypassing the effective-score filter that core's
// buildCraftedToolSetFromExecute applies — two injection policies that had
// already drifted. selectInjectableCraftedTools is now the preamble path's
// selection and reuses core's filterByEffectiveScore, so a score-retired tool
// disappears from the sandbox preamble too.
import { describe, test, expect, mock } from "bun:test";
import type { CraftedTool, CraftStore } from "@kinu/core";
import { craftFailureMarker, initCraftScoreTables } from "@kinu/core";
import { createTestSql } from "@kinu/test-utils";

// @cloudflare/codemode (the DWE import) needs the workerd-only module.
mock.module("cloudflare:workers", () => ({ RpcTarget: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
const { selectInjectableCraftedTools, buildToolsPreamble, injectPreamble } = await import("../src/crafted-tool-registry");
const { craftedDispatcherEntry } = await import("../src/execute-tools");

function makeCraftStore(tools: Array<{ name: string; code: string; description?: string }>): CraftStore {
  const rows: CraftedTool[] = tools.map((t) => ({
      name: t.name, code: t.code, description: t.description ?? "",
      params: null, scope: "local", createdAt: 0, updatedAt: 0,
  }));
  const unsupported = (): never => { throw new Error("unused CraftStore operation"); };
  return {
    create: unsupported,
    update: unsupported,
    get: () => undefined,
    delete: unsupported,
    list: () => rows,
    search: () => [],
    getAll: () => rows,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
  throw new Error("Expected promise to reject");
}

describe("selectInjectableCraftedTools — one policy with core", () => {
  test("drops comment-only code and score-retired tools; keeps healthy + unscored", () => {
    const { db, sql } = createTestSql();
    initCraftScoreTables((ddl: string) => db.exec(ddl));
    const now = Date.now();
    void sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('healthy', 0.9, 4, ${now})`;
    void sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('retired', 0.01, 9, ${now})`;

    const store = makeCraftStore([
      { name: "healthy", code: "async (args) => 1" },
      { name: "retired", code: "async (args) => 2" },
      { name: "unscored", code: "async (args) => 3" },
      { name: "commented_out", code: "// disabled" },
      { name: "empty", code: "   " },
    ]);

    const selected = selectInjectableCraftedTools(store, sql);
    expect(selected.map((t) => t.name)).toEqual(["healthy", "unscored"]);

    // And the preamble the sandbox sees reflects exactly that selection.
    const preamble = buildToolsPreamble(selected);
    expect(preamble).toContain("healthy:");
    expect(preamble).toContain("unscored:");
    expect(preamble).not.toContain("retired");
    expect(preamble).not.toContain("commented_out");
  });

  test("the preamble is valid JS and each body keeps the sandbox's lexical scope", async () => {
    const preamble = buildToolsPreamble([
      { name: "double", code: "async (n) => n * 2" },
      // The property an IIFE wrapper must not break: a crafted body reads the
      // surrounding sandbox scope, and calls its siblings through `tools`.
      { name: "scaled", code: "async (n) => (await tools.double(n)) * factor" },
    ]);
    const run = new Function("factor", `return (async () => {\n  ${preamble}\n  return [await tools.double(4), await tools.scaled(5)];\n})()`);
    expect(await run(10)).toEqual([8, 100]);
  });

  test("a body that ends in a line comment does not break the whole preamble", async () => {
    // Model-authored bodies routinely end in `// …`. On one line the comment
    // would swallow the rest of the wrapper and make EVERY execute a syntax
    // error, taking down every other crafted tool with it.
    const preamble = buildToolsPreamble([
      { name: "commented", code: "async (n) => n + 1 // adds one" },
      { name: "after", code: "async (n) => n * 3" },
    ]);
    const run = new Function(`return (async () => {\n  ${preamble}\n  return [await tools.commented(1), await tools.after(2)];\n})()`);
    expect(await run()).toEqual([2, 6]);
  });

  test("a crafted body that raises is stamped with the tool that raised it", async () => {
    const preamble = buildToolsPreamble([
      { name: "boom", code: 'async () => { throw new Error("inner"); }' },
    ]);
    const run = new Function(`return (async () => {\n  ${preamble}\n  return tools.boom();\n})()`);
    const execution: Promise<unknown> = run();
    const err = await rejectionOf(execution);
    expect(err.message).toBe(`${craftFailureMarker("boom")} inner`);
    expect(err.cause).toBeInstanceOf(Error);
  });

  // ── The preamble reaches EVERY code shape the model writes ──────────────
  // injectPreamble used to regex-splice into the head of `async (...) => {` on
  // the model's raw code and drop the preamble silently when that head was
  // absent. A bare statement body has no such head — and a bare statement body
  // is what BUILTIN_TOOL_SPECS.execute_tools.example teaches — so the whole
  // crafted-tool surface was undefined on those calls. These run the injected
  // program for real: `tools.<name>` either resolves or the test throws.
  const doubler = () => buildToolsPreamble([{ name: "double", code: "async (n) => n * 2" }]);

  test("a bare statement body still sees tools.<name>", async () => {
    const injected = injectPreamble("const n = 4;\nreturn await tools.double(n);", doubler());
    expect(await new Function(`return (${injected})()`)()).toBe(8);
  });

  test("a bare trailing expression still sees tools.<name>", async () => {
    const injected = injectPreamble("await tools.double(21)", doubler());
    expect(await new Function(`return (${injected})()`)()).toBe(42);
  });

  test("a concise-body arrow still sees tools.<name>", async () => {
    const injected = injectPreamble("async () => await tools.double(3)", doubler());
    expect(await new Function(`return (${injected})()`)()).toBe(6);
  });

  test("the arrow shape the model already wrote keeps working", async () => {
    const injected = injectPreamble("async () => { return await tools.double(5); }", doubler());
    expect(await new Function(`return (${injected})()`)()).toBe(10);
  });

  test("the model's code still closes over the sandbox namespaces around it", async () => {
    // DWE declares each provider namespace as a `const` in the scope that
    // encloses the evaluated arrow. Wrapping rather than splicing must not cost
    // the model that scope — `workspace` here stands in for any of them.
    const injected = injectPreamble("return await tools.double(await workspace.size())", doubler());
    const run = new Function("workspace", `return (${injected})()`);
    expect(await run({ size: async () => 6 })).toBe(12);
  });

  test("with no crafted tools the model's code is handed through untouched", () => {
    expect(injectPreamble("return 1", buildToolsPreamble([]))).toBe("return 1");
  });

  test("codemode.<name> raises and names the form that works", async () => {
    // The dispatcher entry exists so the sandbox TYPES declare the crafted
    // name; the callable body is the preamble's `tools.<name>`. Returning an
    // error object here would read as a successful call to both the model and
    // the runtime — including the in-episode fitness observer.
    const entry = craftedDispatcherEntry("doubleIt", "doubles");
    expect(entry.description).toBe("doubles");
    const err = await rejectionOf(entry.execute());
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("tools.doubleIt(args)");
    expect(err.message).toContain("not codemode.doubleIt(args)");
  });

  test("a broken craft store surfaces its failure rather than an empty selection", () => {
    const { sql } = createTestSql();
    const store = makeCraftStore([]);
    expect(selectInjectableCraftedTools(store, sql)).toEqual([]);

    // The empty selection above is what a HEALTHY store with no tools returns,
    // so answering a broken one the same way made them indistinguishable — and
    // the selection feeds both the sandbox preamble and the codemode type
    // surface, so the model's own tools would just be gone with nothing saying
    // why. `crafted_tools` is created by createCFRuntime before anything reads
    // it (and is declared EVERYWHERE in the conformance manifest), so a store
    // that cannot list is a fault.
    store.list = () => { throw new Error("not initialized"); };
    expect(() => selectInjectableCraftedTools(store, sql)).toThrow("not initialized");
  });
});
