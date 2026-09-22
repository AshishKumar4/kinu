/** A preview that arrives on its own never steals the surface: it raises a chip; only explicit intent navigates. */

import { useCallback, useState } from "react";
import type { SlateSummary } from "@kinu.run/core";
import type { PinnedPreviewPort as PinnedPort } from "@kinu.run/core";
import { SLATE_PREFIX } from "./presence";
import type { SurfaceKind } from "./WorkSurface";

/**
 * SAFETY: use-kinu builds previewFocus as `slate:${id}` / `preview:${executor}:${port}`, so re-adding
 * the dropped prefix reconstructs the strip's own surface id, not a guessed string.
 */
function focusSurfaceOf(previewFocus: string | null | undefined): SurfaceKind | null {
  if (previewFocus === null || previewFocus === undefined) return null;

  if (previewFocus.startsWith("slate:")) return `${SLATE_PREFIX}${previewFocus.slice(6)}`;

  if (previewFocus.startsWith("preview:")) return `preview:${previewFocus.slice(8)}`;

  return null;
}

/** A dismissed arrival stays down until a different previewFocus arrives. */
function readyChipSurface(
  previewFocus: string | null | undefined,
  surface: SurfaceKind,
  dismissed: string | null,
): SurfaceKind | null {
  const target = focusSurfaceOf(previewFocus);

  return target !== null && target !== surface && previewFocus !== dismissed ? target : null;
}

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

/** Landing on the arrival's surface consumes it; landing elsewhere leaves the dismissal alone. */
function dismissalAfter(
  previewFocus: string | null | undefined,
  target: SurfaceKind,
  dismissed: string | null,
): string | null {
  return target === focusSurfaceOf(previewFocus) ? (previewFocus ?? null) : dismissed;
}

export interface ReadyChip {
  readonly surface: SurfaceKind;
  readonly title: string;
}

export interface SurfaceFocus {
  readonly surface: SurfaceKind;
  readonly readyChip: ReadyChip | null;
  readonly dismissChip: () => void;
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
