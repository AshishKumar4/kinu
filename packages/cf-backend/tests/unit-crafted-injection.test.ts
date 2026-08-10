// Regression tests for the preamble injection policy.
//
// PreambleCraftedExecutor used to inject EVERY non-comment crafted tool via a
// raw craftStore.list(), bypassing the effective-score filter that core's
// buildCraftedToolSetFromExecute applies — two injection policies that had
// already drifted. selectInjectableCraftedTools is now the preamble path's
// selection and reuses core's filterByEffectiveScore, so a score-retired tool
// disappears from the sandbox preamble too.
import { describe, test, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import type { CraftStore, SqlExecutor, SqlValue } from "@proteus/core";
import { craftFailureMarker, initCraftScoreTables } from "@proteus/core";

// @cloudflare/codemode (the DWE import) needs the workerd-only module.
mock.module("cloudflare:workers", () => ({ RpcTarget: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
const { selectInjectableCraftedTools, buildToolsPreamble } = await import("../src/crafted-tool-registry.js");
const { craftedDispatcherEntry } = await import("../src/execute-tools.js");

function makeSql(db: Database): SqlExecutor {
  return (<T,>(strings: TemplateStringsArray, ...values: SqlValue[]): T[] => {
    const query = strings.reduce((acc, s, i) => acc + s + (i < values.length ? "?" : ""), "");
    const stmt = db.prepare(query);
    if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return stmt.all(...(values as never[])) as T[];
    stmt.run(...(values as never[]));
    return [];
  }) as SqlExecutor;
}

function makeCraftStore(tools: Array<{ name: string; code: string; description?: string }>): CraftStore {
  return {
    list: () => tools.map((t) => ({
      name: t.name, code: t.code, description: t.description ?? "",
      params: null, scope: "local", created_at: 0, updated_at: 0,
    })),
  } as unknown as CraftStore;
}

describe("selectInjectableCraftedTools — one policy with core", () => {
  test("drops comment-only code and score-retired tools; keeps healthy + unscored", () => {
    const db = new Database(":memory:");
    initCraftScoreTables((ddl: string) => db.exec(ddl));
    const sql = makeSql(db);
    const now = Date.now();
    sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('healthy', 0.9, 4, ${now})`;
    sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at) VALUES ('retired', 0.01, 9, ${now})`;

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
    const err = await (run() as Promise<unknown>).catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe(`${craftFailureMarker("boom")} inner`);
    expect((err as Error).cause).toBeInstanceOf(Error);
  });

  test("codemode.<name> raises and names the form that works", async () => {
    // The dispatcher entry exists so the sandbox TYPES declare the crafted
    // name; the callable body is the preamble's `tools.<name>`. Returning an
    // error object here would read as a successful call to both the model and
    // the runtime — including the in-episode fitness observer.
    const entry = craftedDispatcherEntry("doubleIt", "doubles");
    expect(entry.description).toBe("doubles");
    const err = await entry.execute().then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("tools.doubleIt(args)");
    expect(err!.message).toContain("not codemode.doubleIt(args)");
  });

  test("a broken craft store yields an empty selection, not a throw", () => {
    const db = new Database(":memory:");
    const store = { list: () => { throw new Error("not initialized"); } } as unknown as CraftStore;
    expect(selectInjectableCraftedTools(store, makeSql(db))).toEqual([]);
  });
});
