// Head report-summary capture — the #176 fix for empty per-head merge summaries.
import { describe, test, expect } from "bun:test";
import { extractFinalText, synthesizeHeadSummary, extractHeadSteps } from "../src/lib/head-summary";

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

describe("extractHeadSteps", () => {
  test("walks v6 steps into ordered trace; matches tool output to input by toolCallId", () => {
    const steps = extractHeadSteps([
      { text: "Let me check the file.", reasoningText: "I should read it first" },
      {
        text: "",
        toolCalls: [{ toolName: "sandbox_read", input: { path: "/a.ts" }, toolCallId: "c1" }],
        toolResults: [{ toolName: "sandbox_read", output: "file contents", toolCallId: "c1" }],
      },
      { text: "The file defines a router." },
    ]);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ text: "Let me check the file.", reasoning: "I should read it first", toolCalls: [] });
    expect(steps[1].toolCalls[0]).toEqual({ name: "sandbox_read", input: { path: "/a.ts" }, output: "file contents" });
    expect(steps[2]).toEqual({ text: "The file defines a router.", reasoning: undefined, toolCalls: [] });
  });

  test("falls back to positional output match when toolCallId is absent", () => {
    const steps = extractHeadSteps([
      { toolCalls: [{ name: "exec", input: "ls" }], toolResults: [{ output: "a.ts b.ts" }] },
    ]);
    expect(steps[0].toolCalls[0]).toEqual({ name: "exec", input: "ls", output: "a.ts b.ts" });
  });

  test("drops empty padding steps (no text, reasoning, or tool calls)", () => {
    const steps = extractHeadSteps([{ text: "" }, {}, { text: "real" }]);
    expect(steps).toEqual([{ text: "real", reasoning: undefined, toolCalls: [] }]);
  });

  test("digests oversized input/output", () => {
    const big = "x".repeat(2000);
    const steps = extractHeadSteps([{ toolCalls: [{ name: "t", input: big }], toolResults: [{ output: big }] }]);
    expect(String(steps[0].toolCalls[0].input).length).toBeLessThan(900);
    expect(String(steps[0].toolCalls[0].output).length).toBeLessThan(900);
  });

  test("returns [] for empty / undefined", () => {
    expect(extractHeadSteps(undefined)).toEqual([]);
    expect(extractHeadSteps([])).toEqual([]);
  });
});
