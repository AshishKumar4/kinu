/**
 * Captures the fleet turn rows `observeFleetRows` writes. The plane memoises on the env object, first
 * touched before any capture installs, so the capture lives on a copy of the harness env.
 */
import { analyticsPlane, type AnalyticsDatasetSink, type AnalyticsEnv, type AnalyticsPlane, type AnalyticsStats } from '@kinu.run/core/analytics';
import { AwaitedList } from '@kinu.run/test-utils';

export interface FleetPoint {
  readonly indexes?: ((ArrayBuffer | string) | null)[];
  readonly blobs?: ((ArrayBuffer | string) | null)[];
  readonly doubles?: number[];
}

interface Captured extends FleetPoint {}



interface FleetPlane {
  readonly agent: { readonly points: Captured[] };
}

interface Holder {
  readonly env: AnalyticsEnv;
  readonly plane: AnalyticsPlane;
  readonly points: Captured[];
  readonly written: AwaitedList<Captured>;
}

interface EnvWithFleetPlane extends Env {
  __fleetPlaneForTest?: Holder;
}

interface FleetSink extends AnalyticsDatasetSink {
  readonly points: Captured[];
  /** Waitable, so a suite awaits a detached lane's row instead of polling. */
  readonly written: AwaitedList<Captured>;
}

function fleetSink(): FleetSink {
  const written = new AwaitedList<Captured>();

  const sink: FleetSink = {
    points: written.items,
    written,
    writeDataPoint: (point?: Captured) => { written.push(point ?? {}); },
  };

  return sink;
}

function nullSink(): AnalyticsDatasetSink {
  return { writeDataPoint: () => {} };
}


/** A copy of the harness env whose datasets capture. */
export function fleetEnvForTest(env: Env): EnvWithFleetPlane {
  const agent = fleetSink();

  const copy: EnvWithFleetPlane = {
    ...env,
    AGENT_METRICS: agent,
    FEEDBACK_MARKERS: nullSink(),
    CONTROL_PLANE_OPS: nullSink(),
  };

  const planeEnv: AnalyticsEnv = copy;

  copy.__fleetPlaneForTest = { env: planeEnv, plane: analyticsPlane(planeEnv), points: agent.points, written: agent.written };

  return copy;
}

function holderOf(env: EnvWithFleetPlane): Holder {
  const holder = env.__fleetPlaneForTest;

  if (holder === undefined) throw new Error('fleet plane used before its installation');

  return holder;
}

/** Open the plane's write window, as the invocation seam does in production. */
export function openAnalyticsWindowForTest(env: EnvWithFleetPlane): void {
  holderOf(env).plane.window.open();
}

export function fleetPlaneForTest(env: EnvWithFleetPlane): FleetPlane {
  const holder = holderOf(env);

  return { agent: { points: holder.points } };
}

/** Resolves once the fleet dataset holds a point `holds` accepts. */
export function fleetPointWritten(env: EnvWithFleetPlane, holds: (points: readonly FleetPoint[]) => boolean): Promise<void> {
  return holderOf(env).written.until(holds);
}

export function fleetStatsForTest(env: EnvWithFleetPlane): AnalyticsStats {
  const holder = holderOf(env);

  return { ...holder.plane.agent.stats };
}

export type { AnalyticsEnv };
