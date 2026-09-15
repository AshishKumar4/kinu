/**
 * The analytics plane for suites that pin what the actor records: the fleet
 * turn rows `observeFleetRows` writes, captured rather than sent.
 *
 * The plane memoises on the env OBJECT (`analyticsPlane`), and the harness
 * env is built — and first touched — before any suite installs a capture.
 * So the capture lives on a COPY of the harness env: the harness factory
 * takes an optional whole env, and a suite that needs the plane builds the
 * actor over the copy. The copy carries the same bindings plus the capture
 * sinks; the plane builds its writers over it on first touch.
 */
import { analyticsPlane, type AnalyticsDatasetSink, type AnalyticsEnv, type AnalyticsPlane, type AnalyticsStats } from '@kinu.run/core/analytics';

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
}

interface EnvWithFleetPlane extends Env {
  __fleetPlaneForTest?: Holder;
}

interface FleetSink extends AnalyticsDatasetSink {
  readonly points: Captured[];
}

function fleetSink(): FleetSink {
  const points: Captured[] = [];

  const sink: FleetSink = {
    points,

    writeDataPoint: (point?: Captured) => { points.push(point ?? {}); },
  };

  return sink;
}

function nullSink(): AnalyticsDatasetSink {
  return { writeDataPoint: () => {} };
}


/** A copy of the harness env whose datasets capture: the plane's own env. */
export function fleetEnvForTest(env: Env): EnvWithFleetPlane {
  const agent = fleetSink();

  const copy: EnvWithFleetPlane = {
    ...env,
    AGENT_METRICS: agent,
    FEEDBACK_MARKERS: nullSink(),
    CONTROL_PLANE_OPS: nullSink(),
  };

  const planeEnv: AnalyticsEnv = copy;

  copy.__fleetPlaneForTest = { env: planeEnv, plane: analyticsPlane(planeEnv), points: agent.points };

  return copy;
}

/** The holder `fleetEnvForTest` paired with this env. */
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

/** The real plane's write stats for this env: accepted, refused, skipped. */
export function fleetStatsForTest(env: EnvWithFleetPlane): AnalyticsStats {
  const holder = holderOf(env);

  return { ...holder.plane.agent.stats };
}

export type { AnalyticsEnv };
