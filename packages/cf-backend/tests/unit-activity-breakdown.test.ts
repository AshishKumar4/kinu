// The Activity surface's breakdown view model. Category attribution is exact
// in the unit Proteus measures (composed-content characters); it must never be
// presented as provider token attribution.
import { describe, test, expect } from "bun:test";
import type { ContextComposition, ContextSegment } from "@proteus/core";
import { breakdownView, shareOfMeasured } from "../src/components/surfaces/activity-breakdown";

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
    ]));
    expect(view.planes.map((p) => p.plane)).toEqual(["system", "messages"]);
  });

  test("orders rows within a plane by weight, heaviest first", () => {
    const view = breakdownView(compose([
      seg("tools", "web", 400),
      seg("tools", "file", 1600),
      seg("tools", "run", 800),
    ]));
    expect(view.planes[0]?.rows.map((r) => r.label)).toEqual(["file", "run", "web"]);
    expect(view.planes[0]?.chars).toBe(2800);
  });

  test("preserves exact character counts instead of estimating category tokens", () => {
    const view = breakdownView(compose([
      seg("system", "Soul", 1001),
      seg("messages", "user", 502),
    ]));
    expect(view.measuredChars).toBe(1503);
    expect(view.planes[0]?.rows[0]).toEqual({ label: "Soul", chars: 1001, items: 1 });
    expect(view.planes[1]?.rows[0]).toEqual({ label: "user", chars: 502, items: 1 });
  });

  test("a span floor of 1 keeps an empty measurement from dividing by zero", () => {
    expect(breakdownView(compose([])).span).toBe(1);
  });

  test("folded item counts survive into the rows", () => {
    const view = breakdownView(compose([seg("messages", "tool", 4000, 18)]));
    expect(view.planes[0]?.rows[0]).toEqual({ label: "tool", chars: 4000, items: 18 });
  });
});

describe("shareOfMeasured", () => {
  test("is null when no content was measured — 0% would claim a measurement", () => {
    expect(shareOfMeasured(500, 0)).toBeNull();
  });

  test("is the exact share of measured composed-content characters", () => {
    expect(shareOfMeasured(250, 1000)).toBe(0.25);
  });
});
