// Head summaries preserve the final answer and the evidence recorded during work.
import { describe, test, expect } from "bun:test";
import { extractFinalText, synthesizeHeadSummary, toHeadStep } from "../src/heads/head-summary";

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

describe("live head trace", () => {
  test("pairs tool outputs by call identity despite a different result order", () => {
    const step = toHeadStep({
      text: "Read both files",
      toolCalls: [
        { toolName: "file", input: { path: "/a.ts" }, toolCallId: "a" },
        { toolName: "file", input: { path: "/b.ts" }, toolCallId: "b" },
      ],
      toolResults: [
        { output: "B", toolCallId: "b" },
        { output: "A", toolCallId: "a" },
      ],
    });

    expect(step?.toolCalls).toEqual([
      { name: "file", input: { path: "/a.ts" }, output: "A" },
      { name: "file", input: { path: "/b.ts" }, output: "B" },
    ]);
  });

  test("omits padding but retains reasoning-only steps", () => {
    expect(toHeadStep({ text: " " })).toBeNull();
    expect(toHeadStep({ reasoningText: "Check the invariant" })).toEqual({
      text: "", reasoning: "Check the invariant", toolCalls: [],
    });
  });
});
