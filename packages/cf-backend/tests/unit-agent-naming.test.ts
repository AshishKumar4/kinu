// Agent naming — the P1a single-prompt-box flow: slug for the DO id, a
// deterministic provisional title, and the roster title-precedence rule.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect } from "bun:test";
import { slugifyName, deriveWorkspaceTitle, resolveWorkspaceTitle } from "../src/lib/agent-naming";

describe("slugifyName", () => {
  test("lowercases, hyphenates, trims, caps at 24 chars", () => {
    expect(slugifyName("Research Rust Frameworks")).toBe("research-rust-frameworks");
    expect(slugifyName("  Build a Benchmark!!  ")).toBe("build-a-benchmark");
    expect(slugifyName("A".repeat(40))).toBe("a".repeat(24));
    expect(slugifyName("!!!")).toBe("");
  });
});

describe("deriveWorkspaceTitle", () => {
  test("takes the first non-empty line, collapses whitespace, caps at 60", () => {
    expect(deriveWorkspaceTitle("Compare the top 3 Rust web frameworks\n\nmore detail"))
      .toBe("Compare the top 3 Rust web frameworks");
    expect(deriveWorkspaceTitle("\n\n  Second line is first content  \nthird"))
      .toBe("Second line is first content");
    expect(deriveWorkspaceTitle("word ".repeat(40)).length).toBe(60);
  });

  test("returns '' for blank / whitespace-only text", () => {
    expect(deriveWorkspaceTitle("")).toBe("");
    expect(deriveWorkspaceTitle("   \n  \n")).toBe("");
  });
});

describe("resolveWorkspaceTitle — roster precedence", () => {
  const slug = "research-rust-3f8a2c";

  test("an explicit title wins (AI-titled re-sync)", () => {
    expect(resolveWorkspaceTitle({ explicit: "Rust Framework Showdown", existing: "old", purpose: "x", slug }))
      .toBe("Rust Framework Showdown");
  });

  test("no explicit title keeps the existing roster title (no clobber on re-register)", () => {
    expect(resolveWorkspaceTitle({ existing: "Compare Rust Frameworks", purpose: "ignored", slug }))
      .toBe("Compare Rust Frameworks");
    expect(resolveWorkspaceTitle({ explicit: "   ", existing: "Compare Rust Frameworks", slug }))
      .toBe("Compare Rust Frameworks");
  });

  test("first registration with no title derives a provisional from the mission", () => {
    expect(resolveWorkspaceTitle({ purpose: "Benchmark 3 Rust web frameworks\n\nwith load tests", slug }))
      .toBe("Benchmark 3 Rust web frameworks");
  });

  test("falls back to the slug when there is nothing to derive from", () => {
    expect(resolveWorkspaceTitle({ slug })).toBe(slug);
    expect(resolveWorkspaceTitle({ purpose: "   ", slug })).toBe(slug);
  });
});

// Where the workspace DO hangs the shared titling policy. The decision and the
// apply loop are proven in @kinu.run/core; these pin the wiring that a DO test
// harness cannot reach.
describe("workspace titling wiring (OrchestratorAgent)", () => {
  const orchestrator = readFileSync(join(import.meta.dir, "../src/orchestrator.ts"), "utf8");

  test("opening a legacy workspace titles it from SOUL.md without blocking boot", () => {
    // Bounded by a REGEX, and the match is asserted: anchored on the literal
    // "async onStart()" this slice silently became `slice(-1, …)` the day the
    // method turned synchronous, and a wiring test that matches nothing passes.
    const body = /\n  (?:async )?onStart\(\)[\s\S]*?\n  \}\n/.exec(orchestrator);
    expect(body).not.toBeNull();
    const onStart = body![0];
    expect(onStart).toContain("if (this.getOwnerUserId() && isPlaceholderWorkspaceTitle(this.config.getDisplayName(), this.name))");
    expect(onStart).toContain("void readSoul(this.rt.storage.vfs)");
    expect(onStart).toContain(".catch((error) =>");
  });

  // A workspace is titled after what it is FOR. Titling it from the first
  // thing it was asked to do is how a workspace whose mission is "My personal
  // assistant, Jarvis" ends up named after an unrelated errand.
  test("the first turn titles from the MISSION, falling back to the opening request", () => {
    expect(orchestrator).toContain("const mission = readMission(this.boundSql)");
    expect(orchestrator).toContain(
      "void this.maybeAutoTitleWorkspace(isPlaceholderMission(mission) ? userText : mission!)",
    );
    expect(orchestrator.match(/maybeAutoTitleWorkspace\(/g)).toHaveLength(3);
  });

  test("titling persists through setAutoDisplayName, which marks name_origin auto", () => {
    const method = orchestrator.slice(
      orchestrator.indexOf("private async maybeAutoTitleWorkspace"),
      orchestrator.indexOf("private async suggestWorkspaceTitle"),
    );
    expect(method).toContain("applyWorkspaceTitle({");
    expect(method).toContain("persist: async (name) => { await this.setAutoDisplayName(name); }");
    const setAutoDisplayName = orchestrator.slice(orchestrator.indexOf("async setAutoDisplayName("));
    expect(setAutoDisplayName).toContain("this.config.setNameOrigin('auto')");
  });

  test("one generator: the shared workspace-identity prompt and parser", () => {
    const suggest = orchestrator.slice(
      orchestrator.indexOf("private async suggestWorkspaceTitle"),
      orchestrator.indexOf("/** Push a display name to all three homes"),
    );
    expect(suggest).toContain("system: WORKSPACE_TITLE_SYSTEM_PROMPT");
    expect(suggest).toContain("prompt: workspaceTitlePrompt(mission)");
    // `result.text`, not a destructured `text`: the whole result is held now so
    // the call's usage can be reported as `fast` workspace spend. Same parser.
    expect(suggest).toContain("parseWorkspaceTitle(result.text)");
    // The call reports itself as `fast` workspace spend — before this, titling
    // was one of 25 producers whose cost reached no ledger at all.
    expect(suggest).toContain("this.reportModelCall(");
    expect(suggest).toContain("source: 'fast'");
    expect(suggest).not.toContain("maxOutputTokens");
  });
});
