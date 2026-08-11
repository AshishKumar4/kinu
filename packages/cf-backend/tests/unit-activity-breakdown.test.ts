// The Activity surface's breakdown view model. What is under test is that the
// rows stay an estimate and the disagreement with the provider stays visible.
import { describe, test, expect } from "bun:test";
import type { ContextComposition, ContextSegment } from "@proteus/core";
import { breakdownView, shareOfReported } from "../src/components/surfaces/activity-breakdown";

const seg = (plane: ContextSegment["plane"], label: string, chars: number, items = 1): ContextSegment =>
  ({ plane, label, chars, items });

const compose = (segments: ContextSegment[]): ContextComposition => {
  const measuredChars = segments.reduce((s, x) => s + x.chars, 0);
  return { segments, measuredChars, charsPerToken: 4, estimatedTokens: Math.ceil(measuredChars / 4) };
};

describe("breakdownView", () => {
  test("groups into planes in wire order and drops planes with nothing in them", () => {
    const view = breakdownView(compose([
      seg("messages", "user", 400),
      seg("system", "Soul", 800),
    ]), 1000);
    expect(view.planes.map((p) => p.plane)).toEqual(["system", "messages"]);
  });

  test("orders rows within a plane by weight, heaviest first", () => {
    const view = breakdownView(compose([
      seg("tools", "web", 400),
      seg("tools", "file", 1600),
      seg("tools", "run", 800),
    ]), 1000);
    expect(view.planes[0]?.rows.map((r) => r.label)).toEqual(["file", "run", "web"]);
    expect(view.planes[0]?.tokens).toBe(700);
  });

  test("the residual is signed: a shortfall is positive, an overshoot negative", () => {
    const context = compose([seg("system", "Soul", 4000)]); // 1000 est tokens
    expect(breakdownView(context, 1200).residual).toBe(200);
    expect(breakdownView(context, 900).residual).toBe(-100);
  });

  test("the residual is never clamped — over-attribution stays visible", () => {
    const view = breakdownView(compose([seg("system", "Soul", 4000)]), 100);
    expect(view.residual).toBe(-900);
    expect(view.estimated).toBe(1000);
  });

  test("the bar spans the larger of the two, so an overshoot is not clipped", () => {
    const context = compose([seg("system", "Soul", 4000)]); // 1000 est
    expect(breakdownView(context, 1200).span).toBe(1200);
    expect(breakdownView(context, 900).span).toBe(1000);
  });

  test("rows are NOT normalised to the provider's total", () => {
    // The whole point: shares are of what was billed, so they under-sum by
    // exactly the residual rather than being scaled to fill it.
    const view = breakdownView(compose([seg("system", "Soul", 4000)]), 1250);
    const summed = view.planes.reduce((s, p) => s + p.tokens, 0);
    expect(summed).toBe(1000);
    expect(shareOfReported(summed, 1250)).toBeCloseTo(0.8, 10);
  });

  test("a span floor of 1 keeps an empty measurement from dividing by zero", () => {
    expect(breakdownView(compose([]), 0).span).toBe(1);
  });

  test("folded item counts survive into the rows", () => {
    const view = breakdownView(compose([seg("messages", "tool", 4000, 18)]), 1000);
    expect(view.planes[0]?.rows[0]).toEqual({ label: "tool", tokens: 1000, items: 18 });
  });
});

describe("shareOfReported", () => {
  test("is null when nothing was reported — 0% would claim a measurement", () => {
    expect(shareOfReported(500, 0)).toBeNull();
  });

  test("is the share of the authoritative total", () => {
    expect(shareOfReported(250, 1000)).toBe(0.25);
  });
});
