/** The harness profile axis (docs/HARNESS-PROFILES.md, "The profile axis"): the workspace setting a step reads, and the
 *  surfaces it can resolve to. The resolver, which reads a model's prompt family, is `resolveHarnessSurface`. */

/** A vendor harness whose surface a model can be shown. */
const HARNESS_PROFILES = ['kinu', 'claude-code', 'codex', 'pi'] as const;

export type HarnessProfile = (typeof HARNESS_PROFILES)[number];

/** A workspace's `harness.mode`: `native` is today's surface, `auto` a profile by the model's family, else that one. */
export const HARNESS_MODES = ['native', 'auto', ...HARNESS_PROFILES] as const;

export type HarnessMode = (typeof HARNESS_MODES)[number];

/** What one step is shown as: `native`, no profile, or the profile its mode resolved to. */
export const HARNESS_SURFACES = ['native', ...HARNESS_PROFILES] as const;

export type HarnessSurface = (typeof HARNESS_SURFACES)[number];

export function isHarnessMode(value: string | null): value is HarnessMode {
  return HARNESS_MODES.some((mode) => mode === value);
}
