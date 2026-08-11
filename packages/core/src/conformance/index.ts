/**
 * Backend conformance gate — reality vs declaration for every composition
 * root.
 *
 * The layer gate (../layergate) pins core's per-layer BEHAVIOUR; it cannot see
 * either backend's wiring, and its own `tool-construction` row is declared
 * unmeasured for exactly that reason. This gate covers the composition roots:
 * a manifest declares which root wires which capability (or why not), and a
 * per-backend harness observes the real built surface. See manifest.ts for
 * the failure class this exists to kill.
 */

export {
  BACKEND_CONFORMANCE,
  CONFORMANCE_PLANES,
  CONFORMANCE_ROOTS,
  PLANE_UNIVERSE,
  WIRED,
  type CapabilityStatus,
  type ConformanceManifest,
  type ConformancePlane,
  type ConformanceRoot,
  type ObservedSurface,
  type RootStatuses,
} from './manifest.js';
export {
  compareSurface,
  normalizeObservedTables,
  observedActionEnum,
  phantomCallables,
  renderConformanceFindings,
  type ConformanceFinding,
  type ConformanceFindingKind,
  type ConformanceReport,
} from './compare.js';
