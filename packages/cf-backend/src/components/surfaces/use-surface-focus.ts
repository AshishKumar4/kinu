/**
 * The surface strip's focus policy: a preview that ARRIVES on its own never
 * steals the surface — it raises a "Preview ready" chip where the reader
 * already is, and only an explicit intent navigates.
 *
 * `useSurfaceFocus` is the whole surface: the strip mounts it, and the unit
 * test drives it through React's static renderer — the hook holds no
 * effects, so nothing is skipped.
 */

import { useCallback, useState } from "react";
import type { SlateSummary } from "@kinu.run/core";
import type { PinnedPreviewPort as PinnedPort } from "@kinu.run/core";
import { SLATE_PREFIX } from "./presence";
import type { SurfaceKind } from "./WorkSurface";

/**
 * The strip surface a passive `previewFocus` names. `previewFocus` arrives as
 * `slate:<id>` / `preview:<executor>:<port>` while the strip speaks
 * `slate:<id>` / `preview:<executor>:<port>` — the slate arm re-adds the
 * prefix the arrival dropped.
 *
 * SAFETY: use-kinu constructs previewFocus as `slate:${added.id}` in
 * applySlates and `preview:${added}` (an `${executor}:${port}` pair) in
 * refreshExposedPorts, and the strip maps those same shapes back to surfaces
 * via slateSurface and `preview:${executor}:${port}`. Re-adding the stripped
 * prefix reconstructs the strip's own surface id, not a guessed string.
 */
function focusSurfaceOf(previewFocus: string | null | undefined): SurfaceKind | null {
  return previewFocus?.startsWith("slate:")
    ? `${SLATE_PREFIX}${previewFocus.slice(6)}`
    : previewFocus?.startsWith("preview:")
      ? `preview:${previewFocus.slice(8)}`
      : null;
}

/**
 * The surface the ready chip would open, or null when no chip shows: an
 * arrival already on screen chips nothing, and a dismissed arrival stays
 * down until a different previewFocus arrives.
 */
function readyChipSurface(
  previewFocus: string | null | undefined,
  surface: SurfaceKind,
  dismissed: string | null,
): SurfaceKind | null {
  const target = focusSurfaceOf(previewFocus);

  return target !== null && target !== surface && previewFocus !== dismissed ? target : null;
}

/** The chip's human name for its target: the Slate's title, the pinned
 *  port's name, or the raw id tail when neither list knows it. */
function readyChipTitle(
  target: SurfaceKind,
  slates: readonly SlateSummary[] | undefined,
  pinnedPorts: readonly PinnedPort[],
): string {
  return target.startsWith(SLATE_PREFIX)
    ? (slates?.find((slate) => `slate:${slate.id}` === target)?.title ?? target.slice(SLATE_PREFIX.length))
    : (pinnedPorts.find((port) => `preview:${port.executor}:${port.port}` === target)?.name
      ?? target.slice("preview:".length).replace(":", " :"));
}

/**
 * What a navigation does to the chip's dismissal. Landing on the surface an
 * arrival pointed at consumes that arrival — the chip's own click navigates
 * through here, and so does a direct click on the arrived tab. Landing
 * anywhere else leaves the dismissal alone, so an arrival survives the
 * reader looking at something else first.
 */
function dismissalAfter(
  previewFocus: string | null | undefined,
  target: SurfaceKind,
  dismissed: string | null,
): string | null {
  return target === focusSurfaceOf(previewFocus) ? (previewFocus ?? null) : dismissed;
}

/** The ready chip as the strip renders it: where it goes, and what to call it. */
export interface ReadyChip {
  readonly surface: SurfaceKind;
  readonly title: string;
}

export interface SurfaceFocus {
  readonly surface: SurfaceKind;
  /** The chip the strip raises over a passive arrival; null while none shows. */
  readonly readyChip: ReadyChip | null;
  /** Put the current arrival down without navigating. */
  readonly dismissChip: () => void;
  /** Every explicit surface change — chip click, tab click, programmatic jump. */
  readonly navigate: (surface: SurfaceKind) => void;
}

export function useSurfaceFocus(input: {
  readonly surface: SurfaceKind;
  readonly previewFocus: string | null | undefined;
  readonly slates: readonly SlateSummary[] | undefined;
  readonly pinnedPorts: readonly PinnedPort[];
  readonly onSurface: (surface: SurfaceKind) => void;
}): SurfaceFocus {
  const [dismissed, setDismissed] = useState<string | null>(null);

  const dismissChip = useCallback(() => {
    setDismissed(input.previewFocus ?? null);
  }, [input.previewFocus]);

  const navigate = useCallback((next: SurfaceKind) => {
    setDismissed((prev) => dismissalAfter(input.previewFocus, next, prev));
    input.onSurface(next);
  }, [input.previewFocus, input.onSurface]);

  const chipSurface = readyChipSurface(input.previewFocus, input.surface, dismissed);

  return {
    surface: input.surface,
    readyChip: chipSurface === null
      ? null
      : { surface: chipSurface, title: readyChipTitle(chipSurface, input.slates, input.pinnedPorts) },
    dismissChip,
    navigate,
  };
}
