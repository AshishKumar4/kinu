/**
 * The data a View may read.
 *
 * A View names an RPC method; it never names a URL, a table, or a file. The
 * whole containment argument for the feature rests on this list being closed
 * and on every member being (a) already reachable by the signed-in owner,
 * (b) read-only, and (c) argument-free apart from an integer row limit.
 *
 * This module is platform-clean on purpose — `packages/core` cannot import the
 * Cloudflare scope table (`cf-backend/src/cli/rpc-gate.ts`), and the spec is
 * validated in core, at write time. The two are held together mechanically
 * rather than by comment: `cf-backend/tests/unit-view-sources.test.ts` fails
 * the build if any name here stops being classed `workspace.read`, stops being
 * `@callable` on the orchestrator, or disappears from the RPC allowlist.
 *
 * Deliberately ABSENT, and not to be added without re-reading this note:
 *   • `listPendingConsents` — consent state is host-owned chrome. A view that
 *     can draw the consent queue can draw a plausible fake of it.
 *   • `sampleOutcomeLabeling` — takes a sampling budget and draws a set; it
 *     reads like a getter and is not one.
 *   • anything taking a caller-chosen string argument (`getMctsNodeDetail`,
 *     `searchMemoryHybrid`, `getGepaRun`) — the source shape here carries no
 *     free-form argument, and widening it to carry one is a new design, not a
 *     new list entry.
 */

export const VIEW_DATA_SOURCES = [
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

export type ViewDataSource = (typeof VIEW_DATA_SOURCES)[number];

/**
 * Surface names the host owns. A View may not take one as its title: agent
 * tabs already render in a marked group, but a tab reading "Releases" beside
 * the real Releases tab is a spoof the marker alone does not answer.
 *
 * `cf-backend/tests/unit-view-sources.test.ts` asserts this covers every member
 * of the UI's `SURFACES` tuple, so a new host surface cannot quietly become
 * impersonable.
 */
export const RESERVED_VIEW_TITLES: readonly string[] = [
  'output',
  'self',
  'exploration',
  'releases',
  'tasks',
  'jobs',
  'environment',
  'activity',
  'changelog',
  'evolutionchangelog',
  'approvals',
  'approval',
  'consent',
  'consents',
  'credentials',
  'settings',
  'signin',
  'login',
];

/** Fold a title to the form `RESERVED_VIEW_TITLES` is keyed by. */
export function normalizeViewTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}
