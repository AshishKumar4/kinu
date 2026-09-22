// Agent naming — the P1a single-prompt-box flow: a deterministic PROVISIONAL
// title that a model's suggestion still replaces, and the roster
// title-precedence rule. The DO id's slug is core's, and its only
// caller-visible form is `mintSubordinateName`, tested there
// (packages/core/tests/unit-agent-identity-naming.test.ts).
import { describe, test, expect } from "bun:test";
import {
  applyWorkspaceTitle, deriveWorkspaceTitle, planWorkspaceTitle, resolveWorkspaceTitle,
  type NameOrigin, type WorkspaceTitleState,
} from '@kinu.run/core';

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

// #18. `resolveWorkspaceTitle` above derives the first line of the prompt, and
// that is all it was ever meant to be: the stand-in a workspace shows for the
// seconds before a model answers. What the owner reported is that the stand-in
// was the FINAL name — the derived title was stored the way a chosen one is, so
// every later titling pass read it as "already named" and left it alone.
describe("a derived title is a stand-in, not the answer", () => {
  const MISSION = "Benchmark 3 Rust web frameworks\n\nwith load tests";

  const SLUG = "quiet-harbor-3f8a2c";

  /** A workspace registry row and the write both titling passes go through. */
  function registry(nameOrigin: NameOrigin) {
    const stored: WorkspaceTitleState = { slug: SLUG, displayName: null, nameOrigin, mission: MISSION };
    const written: Array<[string, NameOrigin]> = [];

    const persist = (title: string, origin: NameOrigin): boolean => {
      written.push([title, origin]);
      stored.displayName = title;
      stored.nameOrigin = origin;

      return true;
    };

    return { stored, written, persist };
  }

  test("a stored derived title is still upgraded by the model's suggestion", async () => {
    // Creation: no model in reach, so only the deterministic stand-in lands.
    const { stored, written, persist } = registry('auto');
    expect(await applyWorkspaceTitle(stored, { persist })).toBe("Benchmark 3 Rust web frameworks");
    expect(stored.displayName).toBe("Benchmark 3 Rust web frameworks");

    // The genesis turn's `auto_title` effect arrives afterwards, WITH a model.
    // It must still plan — the title it finds is the stand-in its own first
    // pass wrote, not a name anybody chose.
    expect(planWorkspaceTitle(stored)).not.toBe(null);
    expect(await applyWorkspaceTitle(stored, { persist, suggest: async () => "Rust Framework Showdown" }))
      .toBe("Rust Framework Showdown");
    expect(stored.displayName).toBe("Rust Framework Showdown");

    // And now it is settled: the generated title is the answer, so a third
    // pass spends no model call and writes nothing.
    expect(await applyWorkspaceTitle(stored, { persist, suggest: async () => "Another Name" })).toBe(null);
    // The stand-in is written once; only the model's answer writes again.
    expect(written).toEqual([
      ["Benchmark 3 Rust web frameworks", 'provisional'],
      ["Rust Framework Showdown", 'auto'],
    ]);
  });

  test("a title the owner typed is never a stand-in, whatever the mission says", async () => {
    const { stored, written, persist } = registry('user');
    stored.displayName = "Jarvis";
    expect(await applyWorkspaceTitle(stored, { persist, suggest: async () => "Rust Framework Showdown" }))
      .toBe(null);
    expect(written).toEqual([]);
    expect(stored.displayName).toBe("Jarvis");
  });
});

