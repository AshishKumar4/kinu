/** Backend conformance gate: a manifest of per-root wiring checked against observed surfaces. */

export {
  BACKEND_CONFORMANCE,
  CONFORMANCE_PLANES,
  CONFORMANCE_PRODUCERS,
  CONFORMANCE_ROOTS,
  PLANE_UNIVERSE,
  WIRED,
  type CapabilityStatus,
  type ConformanceManifest,
  type ConformancePlane,
  type ConformanceRoot,
  type ObservedSurface,
  type RootStatuses,
} from './manifest';

export {
  compareSurface,
  normalizeObservedTables,
  observedActionEnum,
  phantomCallables,
  renderConformanceFindings,
  wiredProducers,
  type ConformanceFinding,
  type ConformanceFindingKind,
  type ConformanceReport,
} from './compare';
