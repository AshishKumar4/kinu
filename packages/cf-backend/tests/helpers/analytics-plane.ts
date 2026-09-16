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
  /** The same points, waitable: a suite awaits the row a detached lane
   *  writes instead of polling for it. */
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

  copy.__fleetPlaneForTest = { env: planeEnv, plane: analyticsPlane(planeEnv), points: agent.points, written: agent.written };

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

/** Resolves once the fleet dataset holds a point `holds` accepts: the write
 *  itself is the signal, so a suite reads the row the plane wrote from a
 *  detached lane without polling for it. */
export function fleetPointWritten(env: EnvWithFleetPlane, holds: (points: readonly FleetPoint[]) => boolean): Promise<void> {
  return holderOf(env).written.until(holds);
}

/** The real plane's write stats for this env: accepted, refused, skipped. */
export function fleetStatsForTest(env: EnvWithFleetPlane): AnalyticsStats {
  const holder = holderOf(env);

  return { ...holder.plane.agent.stats };
}

export type { AnalyticsEnv };
