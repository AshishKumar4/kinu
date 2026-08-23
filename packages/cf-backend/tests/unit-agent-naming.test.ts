// Agent naming — the P1a single-prompt-box flow: slug for the DO id, a
// deterministic provisional title, and the roster title-precedence rule.
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

