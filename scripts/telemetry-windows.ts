/**
 * The telemetry windows staging deploys have read, kept until every row of their events can have landed.
 *
 * A deploy reads its own version's window once the counts hold still past `SETTLE_HOLD_MS` (prod-logs.ts), which
 * covers 99.96% of rows. The rest land later, measured up to 151 min after their event. So each deploy keeps its
 * window here with what it found, and every later deploy reads each kept window once more beside its own: a finding
 * the window did not hold before landed late and is that deploy's red, named for the version that served it. A window
 * stays kept until a read taken `LATE_HORIZON_MS` past its end, so a late red is reported by a later deploy, never
 * lost.
 */

import * as v from 'valibot';
import { putR2Json, r2Text } from './infra-cloudflare';
import { type InfraEnvironment, bucketOf, deployedConfig } from './infra-manifest';

/** Beside the reset records, in the deployment's releases bucket, which a reset keeps. */
export const WINDOWS_KEY = 'telemetry/windows.json';

/** Past the latest row measured: an `actor.startup` 126-151 min after its event (staging 2026-10-08, prod-logs.ts
 *  `SETTLE_CAP_MS`). */
export const LATE_HORIZON_MS = 3 * 60 * 60_000;

export const TelemetryWindowSchema = v.object({
  worker: v.string(),
  version: v.string(),
  from: v.string(),
  to: v.string(),
  /** What its last read found, by each finding's text; null for a window never read to a settled answer. */
  findings: v.nullable(v.array(v.string())),
});

export type TelemetryWindow = v.InferOutput<typeof TelemetryWindowSchema>;

/** One finding as `prod-logs.ts version` reports it. */
export interface WindowFinding {
  readonly what: string;
  readonly finding: string;
}

/** A kept window read again: what it holds now, or why it could not be read. */
export type Reread =
  | { readonly window: TelemetryWindow; readonly found: readonly WindowFinding[] }
  | { readonly window: TelemetryWindow; readonly failed: string };

/** The kept windows of `environment`, and the bucket they are kept in. */
export function keptWindows(environment: InfraEnvironment) {
  const bucket = bucketOf(deployedConfig(environment), 'RELEASES_BUCKET');

  if (bucket === undefined) throw new Error(`the ${environment} deployment binds no RELEASES_BUCKET to keep its telemetry windows in`);
  const text = r2Text(bucket, WINDOWS_KEY);

  const windows: TelemetryWindow[] = text === undefined ? [] : v.parse(v.array(TelemetryWindowSchema), JSON.parse(text));

  return { bucket, windows };
}

export function keepWindows(bucket: string, windows: readonly TelemetryWindow[]): void {
  putR2Json(bucket, WINDOWS_KEY, `${JSON.stringify(windows, null, 1)}\n`);
}

/**
 * What re-reading the kept windows at `readAt` reports, and which stay kept. A finding a window's last read did not
 * hold landed late; a window never read reports everything it holds. A window read `LATE_HORIZON_MS` or more past its
 * end is read for the last time; one that could not be read stays as it was, for the next deploy.
 */
export function afterRereads(rereads: readonly Reread[], readAt: number) {
  const late: WindowFinding[] = [];
  const kept: TelemetryWindow[] = [];

  for (const reread of rereads) {
    const { window } = reread;
    const span = `${window.from} .. ${window.to}`;

    if ('failed' in reread) {
      late.push({ what: `version ${window.version}'s kept window`, finding: `${window.worker}'s telemetry for version `
        + `${window.version} (${span}) could not be read again: ${reread.failed}; it stays kept for the next deploy` });
      kept.push(window);
      continue;
    }

    for (const found of reread.found.filter((each) => window.findings?.includes(each.finding) !== true)) {
      late.push({ what: `late, version ${window.version}: ${found.what}`, finding: `${found.finding} (in ${span}, landed after its own deploy read it)` });
    }

    if (readAt - Date.parse(window.to) < LATE_HORIZON_MS) kept.push({ ...window, findings: reread.found.map((each) => each.finding) });
  }

  return { late, kept };
}
