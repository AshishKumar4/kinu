/**
 * Branching heads — cf-backend public surface.
 *
 * Heads no longer have their own Facet class — they're a mode of
 * ExplorationAgent (initHead / runAsHead / abortHead). This module
 * just exports the CF-side runtime wrapper for HeadController.
 */

export { createCFHeadRuntime } from "./head-runtime";
