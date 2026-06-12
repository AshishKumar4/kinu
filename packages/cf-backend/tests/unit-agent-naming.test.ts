// Agent naming — the P1a single-prompt-box flow: slug for the DO id, a
// deterministic provisional title, and the roster title-precedence rule.
import { describe, test, expect } from "bun:test";
import { slugifyName, deriveAgentTitle, resolveAgentTitle } from "../src/lib/agent-naming";

describe("slugifyName", () => {
  test("lowercases, hyphenates, trims, caps at 24 chars", () => {
    expect(slugifyName("Research Rust Frameworks")).toBe("research-rust-frameworks");
    expect(slugifyName("  Build a Benchmark!!  ")).toBe("build-a-benchmark");
    expect(slugifyName("A".repeat(40))).toBe("a".repeat(24));
    expect(slugifyName("!!!")).toBe("");
  });
});

describe("deriveAgentTitle", () => {
  test("takes the first non-empty line, collapses whitespace, caps at 60", () => {
    expect(deriveAgentTitle("Compare the top 3 Rust web frameworks\n\nmore detail"))
      .toBe("Compare the top 3 Rust web frameworks");
    expect(deriveAgentTitle("\n\n  Second line is first content  \nthird"))
      .toBe("Second line is first content");
    expect(deriveAgentTitle("word ".repeat(40)).length).toBe(60);
  });

  test("returns '' for blank / whitespace-only text", () => {
    expect(deriveAgentTitle("")).toBe("");
    expect(deriveAgentTitle("   \n  \n")).toBe("");
  });
});

describe("resolveAgentTitle — roster precedence", () => {
  const slug = "research-rust-3f8a2c";

  test("an explicit title wins (AI-titled re-sync)", () => {
    expect(resolveAgentTitle({ explicit: "Rust Framework Showdown", existing: "old", purpose: "x", slug }))
      .toBe("Rust Framework Showdown");
  });

  test("no explicit title keeps the existing roster title (no clobber on re-register)", () => {
    expect(resolveAgentTitle({ existing: "Compare Rust Frameworks", purpose: "ignored", slug }))
      .toBe("Compare Rust Frameworks");
    expect(resolveAgentTitle({ explicit: "   ", existing: "Compare Rust Frameworks", slug }))
      .toBe("Compare Rust Frameworks");
  });

  test("first registration with no title derives a provisional from the mission", () => {
    expect(resolveAgentTitle({ purpose: "Benchmark 3 Rust web frameworks\n\nwith load tests", slug }))
      .toBe("Benchmark 3 Rust web frameworks");
  });

  test("falls back to the slug when there is nothing to derive from", () => {
    expect(resolveAgentTitle({ slug })).toBe(slug);
    expect(resolveAgentTitle({ purpose: "   ", slug })).toBe(slug);
  });
});
