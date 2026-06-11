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
import { initCraftScoreTables } from "@proteus/core";

// @cloudflare/codemode (the DWE import) needs the workerd-only module.
mock.module("cloudflare:workers", () => ({ RpcTarget: class {} }));
const { selectInjectableCraftedTools, buildToolsPreamble } = await import("../src/crafted-tool-registry.js");

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

  test("a broken craft store yields an empty selection, not a throw", () => {
    const db = new Database(":memory:");
    const store = { list: () => { throw new Error("not initialized"); } } as unknown as CraftStore;
    expect(selectInjectableCraftedTools(store, makeSql(db))).toEqual([]);
  });
});
