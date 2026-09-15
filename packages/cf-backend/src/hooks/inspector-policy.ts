/**
 * The inspector column's layout POLICY, as the pure half of
 * `use-inspector-layout.ts`: which keys the storage reads, what a stored
 * value means, and what a first visit decides. Everything here is free of
 * React and the DOM except `localStorage`, which a caller supplies — the
 * hook owns the effects that turn these reads into writes and imperative
 * calls; this module owns the questions the effects ask.
 */

export const INSPECTOR_DEFAULT_PX = 340;

export const INSPECTOR_MIN_PX = 280;

export const INSPECTOR_WIDE_QUERY = "(min-width: 900px)";

export interface InspectorTarget { readonly collapsed: boolean; readonly widthPx: number }

/** The WIDTH is the account's: a preference about this person's display,
 *  stored as a plain pixel number beside the theme choice. */
function readInspectorWidth(account: string): number | null {
  const raw = localStorage.getItem(`kinu.inspector.${account}`);
  const width = raw === null ? NaN : Number(raw);

  return Number.isFinite(width) ? Math.max(INSPECTOR_MIN_PX, Math.round(width)) : null;
}

/** The OPEN/CLOSED choice is the workspace's: `"1"` opened here, `"0"` closed
 *  here, absent means the first-visit policy decides. A choice made in one
 *  workspace can never leak into another. */
export function readInspectorChoice(account: string, workspace: string | undefined): boolean | null {
  const raw = workspace === undefined
    ? null
    : localStorage.getItem(`kinu.inspector.open.${account}.${workspace}`);

  return raw === "1" ? true : raw === "0" ? false : null;
}

/** The decided layout: the stored choice when one exists, else the
 *  first-visit policy — collapsed unless the workspace holds something worth
 *  seeing (the live signal, or the one auto-open it already served). */
export function readDecision(
  account: string | null, workspace: string | undefined, showContent: boolean,
): InspectorTarget {
  const width = (account === null ? null : readInspectorWidth(account)) ?? INSPECTOR_DEFAULT_PX;
  const choice = account === null ? null : readInspectorChoice(account, workspace);

  return { collapsed: choice === null ? !showContent : !choice, widthPx: width };
}

/** The keys the library's separator keydown acts on — the marks these press
 *  leave are what the committed layout's classification reads. */
const INSPECTOR_INPUT_KEYS = {
  ArrowLeft: true, ArrowRight: true, Home: true, End: true, Enter: true,
} satisfies Record<string, true>;

export function isInspectorInputKey(key: string): boolean {
  return Object.hasOwn(INSPECTOR_INPUT_KEYS, key);
}
