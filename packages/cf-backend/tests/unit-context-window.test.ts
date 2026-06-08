// Utilization-based compaction threshold — per-model context windows.
import { describe, test, expect } from "bun:test";
import {
  contextWindowForModel,
  compactionThreshold,
  COMPACT_AT_UTILIZATION,
} from "../src/lib/context-window";

describe("contextWindowForModel", () => {
  test("matches known model families on their spec", () => {
    expect(contextWindowForModel("minimax/m3")).toBe(1_000_000);
    expect(contextWindowForModel("@cf/moonshotai/kimi-k2.6")).toBe(262_144);
    expect(contextWindowForModel("@cf/meta/llama-4-scout")).toBe(131_072);
    expect(contextWindowForModel("anthropic/claude-opus-4-7")).toBe(1_000_000);
    expect(contextWindowForModel("openai/gpt-5.5")).toBe(1_050_000);
    expect(contextWindowForModel("codex/gpt-5.5")).toBe(272_000);
    expect(contextWindowForModel("openai/gpt-5.1")).toBe(256_000);
    expect(contextWindowForModel("google/gemini-2.5-pro")).toBe(1_000_000);
  });

  test("falls back to a conservative default for unknown specs", () => {
    expect(contextWindowForModel("")).toBe(128_000);
    expect(contextWindowForModel("some/unknown-model")).toBe(128_000);
  });
});

describe("compactionThreshold", () => {
  test("is 85% of the model window by default (≈15% headroom)", () => {
    expect(COMPACT_AT_UTILIZATION).toBe(0.85);
    expect(compactionThreshold("minimax/m3")).toBe(850_000);
    expect(compactionThreshold("@cf/moonshotai/kimi-k2.6")).toBe(222_822);
    expect(compactionThreshold("unknown")).toBe(108_800);
  });

  test("scales with the model — a bigger window compacts later", () => {
    expect(compactionThreshold("minimax/m3")).toBeGreaterThan(
      compactionThreshold("@cf/moonshotai/kimi-k2.6"),
    );
  });

  test("honours an explicit utilization override", () => {
    expect(compactionThreshold("unknown", 0.5)).toBe(64_000);
  });
});
