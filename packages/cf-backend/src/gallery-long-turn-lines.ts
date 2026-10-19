/**
 * The long turn's lines as Workers AI's fast model wrote them: `@cf/zai-org/glm-5.3`, Kinu's fast tier when none is assigned
 * (core providers/model-registry.ts), at effort `low`, each phase's prompt run three times on 2026-10-19, a call every
 * 7 s. Each line is its first run's; `ms` is every run's latency, end to end from this machine.
 */

export interface MeasuredLine {
  readonly title: string;
  readonly ms: readonly number[];
  readonly prompt: number;
  readonly completion: number;
  readonly neurons: number;
}

export const LINES_MODEL = {
  model: "@cf/zai-org/glm-5.3", effort: "low", runs: 3, measured: "2026-10-19",
  note: "Over 18 calls: median 3.2 s, p90 18.6 s, slowest 66 s; 2 refused by the account's per-minute limit and retried. At Workers AI's list price for glm-5.3 ($1.40 a million tokens in, $4.40 out) a phase's line costs about $0.0007, this turn's six lines $0.0039; the free 10,000 neurons a day cover about 180 lines.",
} as const;

/** By each phase's first call. */
export const PHASE_LINES: ReadonlyMap<string, MeasuredLine> = new Map([
  ["f1", { title: "Traced 500 to renamed D1 binding", ms: [1683, 3830, 3210], prompt: 467, completion: 16, neurons: 19.4 }],
  ["x1", { title: "Fixed reader and test helpers for renamed D1 binding", ms: [66113, 1479, 1753], prompt: 405, completion: 17, neurons: 58.3 }],
  ["r1", { title: "Audited routes and fixed the DB binding reads", ms: [2330, 3263, 18264], prompt: 483, completion: 16, neurons: 54.6 }],
  ["s1", { title: "Migrated DB and deployed fix to staging", ms: [10007, 2060, 3609], prompt: 472, completion: 15, neurons: 52.8 }],
  ["p1", { title: "Deployed to production and verified health", ms: [3157, 1236, 18631], prompt: 506, completion: 14, neurons: 56.7 }],
]);

export const TURN_LINE: MeasuredLine = { title: "Fixed D1 binding 500 and deployed", ms: [54848, 5134, 3090], prompt: 176, completion: 15, neurons: 28.4 };
