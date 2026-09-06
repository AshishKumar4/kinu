/**
 * The workspace data a gadget's `rpc` binding may read.
 *
 * A binding names an RPC method; it never names a URL, a table, or a file.
 * The containment argument rests on this list being closed and on every
 * member being (a) already reachable by the signed-in owner, (b) read-only,
 * and (c) argument-free apart from an integer row limit.
 *
 * This module is platform-clean on purpose — `packages/core` cannot import
 * the Cloudflare scope table (`cf-backend/src/cli/rpc-gate.ts`), and the
 * manifest is validated in core. The two are held together mechanically:
 * `cf-backend/tests/unit-gadget-sources.test.ts` fails the build if any name
 * here stops being classed `workspace.read`, stops being `@callable` on the
 * orchestrator, or disappears from the RPC allowlist.
 *
 * Deliberately ABSENT, and not to be added without re-reading this note:
 *   • `listPendingConsents` — consent state is host-owned chrome. A gadget
 *     that can read the consent queue can draw a plausible fake of it.
 *   • `listPendingActions` — the same argument with more at stake. The
 *     needs-you queue is what an owner reads immediately before authorising
 *     a deploy or promoting a scaffold version; a gadget able to draw it
 *     could draw a convincing counterfeit of it.
 *   • `sampleOutcomeLabeling` — takes a sampling budget and draws a set; it
 *     reads like a getter and is not one.
 *   • anything taking a caller-chosen string argument (`getMctsNodeDetail`,
 *     `searchMemoryHybrid`, `getGepaRun`) — a source here carries no
 *     free-form argument, and widening it to carry one is a new design, not
 *     a new list entry.
 */

export const GADGET_DATA_SOURCES = [
  'getAlignmentConvergence',
  'getExecutors',
  'getGepaRuns',
  'getHeadRuns',
  'getMctsTree',
  'getOutcomeCalibration',
  'getReleaseBoard',
  'getRunTimeline',
  'getToolDescriptions',
  'getWorkspaceSnapshot',
  'listBackgroundJobs',
  'listTriggers',
] as const;

export type GadgetDataSource = (typeof GADGET_DATA_SOURCES)[number];
