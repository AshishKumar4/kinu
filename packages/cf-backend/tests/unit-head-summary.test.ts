// Head report-summary capture — the #176 fix for empty per-head merge summaries.
import { describe, test, expect } from "bun:test";
import { extractFinalText, synthesizeHeadSummary } from "../src/lib/head-summary";

describe("extractFinalText", () => {
  test("uses result.text when the final step has text", () => {
    expect(extractFinalText({ text: "  final answer  " })).toBe("final answer");
  });

  test("recovers the LAST text-bearing step when result.text is empty (head ended on a tool call)", () => {
    // ai-v6 result.text = last step's text only; a tool-final head has empty result.text.
    expect(extractFinalText({
      text: "",
      steps: [{ text: "early reasoning" }, { text: "the real synthesized answer" }, { text: "" }],
    })).toBe("the real synthesized answer");
  });

  test("falls back to reasoningText when no step produced text", () => {
    expect(extractFinalText({
      text: "", steps: [{ text: "" }, {}], reasoningText: "  I reasoned about it  ",
    })).toBe("I reasoned about it");
  });

  test("returns '' when nothing has text", () => {
    expect(extractFinalText({ steps: [{}, {}] })).toBe("");
    expect(extractFinalText({})).toBe("");
  });
});

describe("synthesizeHeadSummary", () => {
  test("synthesizes from decisions + evidence when the head produced no prose", () => {
    const s = synthesizeHeadSummary({
      decisions: [{ question: "Best DB?", choice: "Postgres" }],
      evidence: [{ body: "Postgres has mature JSONB" }],
      toolCalls: [{ name: "record_decision" }],
    });
    expect(s).toContain("Best DB? → Postgres");
    expect(s).toContain("Postgres has mature JSONB");
  });

  test("falls back to tool-call names when there are no decisions/evidence", () => {
    const s = synthesizeHeadSummary({
      decisions: [], evidence: [], toolCalls: [{ name: "sandbox_exec" }, { name: "sandbox_read" }],
    });
    expect(s).toContain("sandbox_exec");
  });

  test("returns null when the head recorded nothing at all", () => {
    expect(synthesizeHeadSummary({ decisions: [], evidence: [], toolCalls: [] })).toBeNull();
  });
});
