/** The Activity surface's frames, over its snapshots. */
import { summarizeSteps } from "@kinu.run/core";
import { CHARS_PER_TOKEN } from "@kinu.run/core";
import type { ActivitySnapshot } from "@kinu.run/core";
import { type WorkspaceRpc } from "@/lib/workspace-rpc";
import type { ContextComposition, ProducerSpend, Usage, WorkspaceSpend } from "@kinu.run/core";
import { ACTIVITY_ACCOUNTS, NOW } from "@/gallery-data";
import { galleryRpc } from "@/gallery-shared";

// Every block is fed so its type roles render at real scale.

/** Typed so fixtures track `RunSummary`. The second run is silent (no provider report) and must render unreported, not free; longer than one page for the pager. */

/** `cacheRead` is a subset of `input`, never an addition. */
const AGENT_TOKENS: Usage = {
  input: 21_480_312, output: 512_884, cacheRead: 18_942_006, reasoning: 41_220,
};

/** As Workers AI reports it: `neurons`, Cloudflare's billing unit, comes back on every call and the Cost block must carry it. */
const AGENT_TOKENS_METERED: Usage = { ...AGENT_TOKENS, neurons: 2_639_183 };

/**
 * One producer per absence rule the Cost block claims (a zero must never stand in for a silence), in
 * `workspaceSpend` order (read-models/workspace-spend.ts): largest measured total first, unmeasured last.
 */
const ACTIVITY_PRODUCERS: ProducerSpend[] = [
  {
    source: "agent", calls: 344, callsWithoutUsage: 0, usage: AGENT_TOKENS_METERED,
    usd: 11.98, unpricedCalls: 0,
  },
  {
    source: "judge", calls: 62, callsWithoutUsage: 0,
    usage: {
      input: 1_284_400, output: 96_120, cacheRead: 812_000,
      cacheWrite: 96_400, cacheWrite1h: 71_200,
    },
    usd: 3.41, unpricedCalls: 0,
  },
  {
    source: "fast", calls: 210, callsWithoutUsage: 0,
    usage: { input: 402_118, output: 18_440, neurons: 50_467 },
    usd: 0.0142, unpricedCalls: 44,
  },
  {
    source: "head", calls: 12, callsWithoutUsage: 2,
    usage: { input: 288_004, output: 31_902 }, usd: 0.86, unpricedCalls: 0,
  },
  {
    source: "swarm", calls: 28, callsWithoutUsage: 0,
    usage: { input: 96_210, output: 12_004, neurons: 12_986 },
    unpricedCalls: 28,
  },
  {
    source: "platform", calls: 91, callsWithoutUsage: 91, usage: {},
    unpricedCalls: 0,
  },
];

/** Everything measured and priced over the whole log, on Anthropic: the neurons column must vanish, not print dashes. */
const CLEAN_PRODUCERS: ProducerSpend[] = [
  {
    source: "agent", calls: 344, callsWithoutUsage: 0, usage: AGENT_TOKENS,
    usd: 11.98, unpricedCalls: 0,
  },
  {
    source: "judge", calls: 62, callsWithoutUsage: 0,
    usage: { input: 1_284_400, output: 96_120, cacheRead: 812_000 },
    usd: 3.41, unpricedCalls: 0,
  },
  {
    source: "fast", calls: 210, callsWithoutUsage: 0,
    usage: { input: 402_118, output: 18_440 }, usd: 0.42, unpricedCalls: 0,
  },
];

const ACTIVITY_CONTEXT: ContextComposition = {
  segments: [
    { plane: "system", label: "Core instructions", chars: 18_400, items: 1 },
    { plane: "system", label: "Code execution and learned capabilities", chars: 3_120, items: 1 },
    { plane: "tools", label: "shell", chars: 2_840, items: 1 },
    { plane: "tools", label: "edit", chars: 3_610, items: 1 },
    { plane: "tools", label: "read", chars: 2_180, items: 1 },
    { plane: "messages", label: "tool", chars: 328_900, items: 96 },
    { plane: "messages", label: "assistant", chars: 214_600, items: 58 },
    { plane: "messages", label: "user", chars: 9_420, items: 11 },
    { plane: "ephemeral", label: "Plan", chars: 1_980, items: 1 },
    { plane: "ephemeral", label: "Open files", chars: 2_240, items: 1 },
  ],
  measuredChars: 587_290,
  charsPerToken: CHARS_PER_TOKEN,
  estimatedTokens: 146_822,
};

const ACTIVITY_LATEST = {
  at: NOW - 90e3,
  runId: "run-8c41f0",
  stepIndex: 7,
  usage: { input: 148_204, output: 1_842, cacheRead: 131_072, reasoning: 604, neurons: 18_005 },
  context: ACTIVITY_CONTEXT,
  modelId: "gpt-5.5",
  route: { kind: "device", id: "dev-studio", name: "studio" },
} satisfies NonNullable<ActivitySnapshot["latest"]>;

const ACTIVITY_CACHE_HIT = {
  samples: 344, last: 0.94, ema: 0.91, mean: 0.88, p95: 0.97, p99: 0.99, emaAlpha: 0.2, warms: 2,
};

/** `&cache=unreported`: a provider that sends no cache counters, as the steps summarize it. */
export const ACTIVITY_CACHE_SHOWN = new URLSearchParams(location.search).get("cache") === "unreported"
  ? summarizeSteps([{ usage: { input: 100 } }], { windowLimit: 200 }).cacheHit : ACTIVITY_CACHE_HIT;

/** One nested label and one spent: a dollar cap, a token cap, blended pricing, and a `spent` badge. */
const ACTIVITY_MISSIONS: WorkspaceSpend["missions"] = [
  {
    label: "api-worker", parent: null, limits: { usd: 25 },
    spent: { tokens: 24_222_394, usd: 16.26 }, remaining: { usd: 8.74 },
    pricing: { blendedTokens: 0, source: "catalog" }, calls: 747, spawns: 3, exhausted: false,
  },
  {
    label: "api-worker/regression-sweep", parent: "api-worker",
    limits: { tokens: 2_000_000 },
    spent: { tokens: 2_004_118, usd: 1.42 }, remaining: { tokens: 0 },
    pricing: { blendedTokens: 118_400, source: "mixed" }, calls: 96, spawns: 0, exhausted: true,
  },
];

/** Oldest first, as `readActivityLog` returns. `elapsedMs: 0` (a row cut outside a turn) must read as an em dash, not 0 ms. */
export const ACTIVITY_LOG: ActivitySnapshot["log"] = [
  { event: "steer_queued", detail: "look at the tests too", elapsedMs: 0, createdAt: NOW - 96e3 },
  { event: "beforeturn", detail: "streamText() called next", elapsedMs: 4, createdAt: NOW - 95e3 },
  {
    event: "gettools_rebuilding", detail: "build:eval,run,file,agents,memory,tasks,web:3:1757011200000:0 → build:eval,run,file,agents,memory,tasks,web:4:1757011260000:0",
    elapsedMs: 11, createdAt: NOW - 95e3,
  },
  {
    event: "gettools_end", detail: "rebuilt — 24 tools", elapsedMs: 287,
    createdAt: NOW - 94e3,
  },
  {
    event: "skills_active", detail: "cloudflare,durable-objects,test-driven-development",
    elapsedMs: 291, createdAt: NOW - 94e3,
  },
  {
    event: "compaction",
    detail: "kept 18 of 46 messages — 132,904 chars over the 120,000 trigger, "
      + "summarised the dropped prefix into one system note",
    elapsedMs: 3_918, createdAt: NOW - 92e3,
  },
  { event: "response_complete", detail: "ok", elapsedMs: 41_602, createdAt: NOW - 90e3 },
];

/** Every qualifier live at once (truncated window, silent and partial producers, unpriced calls): the caveat line must stay one line. */
export const ACTIVITY_SNAPSHOT: ActivitySnapshot = {
  latest: ACTIVITY_LATEST,
  contextWindow: 200_000,
  fill: { tokens: ACTIVITY_LATEST.usage.input, window: 200_000, source: "provider", at: new Date(ACTIVITY_LATEST.at).toISOString() },
  telemetry: {
    steps: 344, windowLimit: 2000, tokens: AGENT_TOKENS_METERED, cacheHit: ACTIVITY_CACHE_HIT,
    usd: 11.98, pricedSteps: 344, unpricedSteps: 0, stepsWithoutUsage: 0,
  },
  spend: {
    producers: ACTIVITY_PRODUCERS,
    total: {
      calls: 747, callsWithoutUsage: 93, unpricedCalls: 72,
      usd: 16.2642,
      usage: {
        input: 23_551_044, output: 671_350, cacheRead: 19_754_006, reasoning: 41_220,
        neurons: 2_702_636,
        // Only `judge` writes cache and reports the retention split.
        cacheWrite: 96_400, cacheWrite1h: 71_200,
      },
    },
    coverage: {
      calls: 747, measured: 654, reported: 654 / 747, silent: ["platform"], partial: ["head"],
    },
    // (23_551_044 + 671_350 - 21_480_312 - 512_884) / (23_551_044 + 671_350)
    offTurnShare: 0.09203045743537984,
    missions: ACTIVITY_MISSIONS,
    accounts: ACTIVITY_ACCOUNTS,
  },
  log: ACTIVITY_LOG,
};

/** A provider without neurons and nothing left to qualify. */
export const ACTIVITY_CLEAN: ActivitySnapshot = {
  ...ACTIVITY_SNAPSHOT,
  latest: { ...ACTIVITY_LATEST, usage: { input: 148_204, output: 1_842, cacheRead: 131_072, reasoning: 604 } },
  telemetry: { ...ACTIVITY_SNAPSHOT.telemetry, tokens: AGENT_TOKENS },
  spend: {
    producers: CLEAN_PRODUCERS,
    total: {
      calls: 616, callsWithoutUsage: 0, unpricedCalls: 0, usd: 15.81,
      usage: {
        input: 23_166_830, output: 627_444, cacheRead: 19_754_006, reasoning: 41_220,
      },
    },
    coverage: { calls: 616, measured: 616, reported: 1, silent: [], partial: [] },
    // (23_166_830 + 627_444 - 21_480_312 - 512_884) / (23_166_830 + 627_444)
    offTurnShare: 0.07569375724596598,
    missions: [],
    accounts: [],
  },
};

/** No model call at all: `coverage.reported` is null and the panel must say there is no fraction, not 0%. */
export const ACTIVITY_FRESH: ActivitySnapshot = {
  latest: null,
  contextWindow: null,
  fill: null,
  telemetry: {
    steps: 0, windowLimit: 2000, tokens: {}, usd: 0, pricedSteps: 0, unpricedSteps: 0,
    stepsWithoutUsage: 0,
    cacheHit: { samples: 0, last: null, ema: null, mean: null, p95: null, p99: null, emaAlpha: 0.2, warms: 0 },
  },
  spend: {
    producers: [],
    total: { calls: 0, callsWithoutUsage: 0, usage: {}, unpricedCalls: 0 },
    coverage: { calls: 0, measured: 0, reported: null, silent: [], partial: [] },
    offTurnShare: null,
    missions: [],
    accounts: [],
  },
  log: [],
};

export const activityRpc = (snapshot: ActivitySnapshot): WorkspaceRpc => galleryRpc({ getActivitySnapshot: () => snapshot });
