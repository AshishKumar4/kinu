/** Which plans have a page tab, which one is shown, and every way a plan's page opens on its own. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { planOfSurface, planSurface, type OwnedPlan, type PlanPageRef, type PlanReview, type PlanSurfaceKind, type Rpc, type SurfaceKind } from "@kinu.run/core";
import type { ReadMoves, WorkspacePlanArrival } from "@/hooks/use-workspace-reads";
import { useWorkspaceWork, type WorkspaceWorkRead } from "./use-workspace-work";

const keyOf = (item: OwnedPlan): PlanSurfaceKind => planSurface({ owner: item.owner.name, id: item.plan.id, revision: item.plan.revision });

const sameRevision = (item: OwnedPlan, ref: PlanPageRef): boolean =>
  item.owner.name === ref.owner && item.plan.id === ref.id && item.plan.revision === ref.revision;

/**
 * The plans with a page: each plan's newest revision while it waits on review, and each revision the reader or the
 * workspace opened until a newer one of the same plan is in the read. The page shown keeps its tab either way.
 */
function planPages(plans: readonly OwnedPlan[], opened: readonly string[], surface: SurfaceKind | null): OwnedPlan[] {
  const newest = new Map<string, number>();

  for (const item of plans) {
    const key = `${item.owner.name}\u0000${item.plan.id}`;

    newest.set(key, Math.max(newest.get(key) ?? 0, item.plan.revision));
  }

  return plans.filter((item) => {
    const page = keyOf(item);
    const latest = newest.get(`${item.owner.name}\u0000${item.plan.id}`) === item.plan.revision;

    return page === surface || (latest && (item.plan.status === "pending" || opened.includes(page)));
  });
}

export interface PlanPages {
  /** The column's one read of plans and tasks. */
  readonly read: WorkspaceWorkRead;
  /** Whose plans this pane decides: the others' it reads. */
  readonly owner: string;
  /** Each plan with a page, in the read's order. */
  readonly pages: readonly OwnedPlan[];
  /** The pages shown this visit that still have a tab: each stays drawn, hidden, with its unsent comments. */
  readonly drawn: readonly OwnedPlan[];
  /** Whether the column shows a plan's page, read or not. */
  readonly selected: boolean;
  /** The plan the shown surface is the page of, once the read holds it. */
  readonly shown: OwnedPlan | undefined;
  /** Shows a plan's page. */
  readonly show: (plan: PlanPageRef) => void;
}

export function usePlanPages({ rpc, readMoves, plan, planOwner, planFocus, arrival, surface, navigate }: {
  rpc: Rpc;
  readMoves: ReadMoves | undefined;
  /** The plan the pane reports, its owner's. */
  plan: PlanReview | null;
  planOwner: string | undefined;
  /** `id:revision` of a new pending plan of the workspace's own, which is the root's: the pane that shows it is too. */
  planFocus: string | null | undefined;
  arrival: WorkspacePlanArrival | null | undefined;
  surface: SurfaceKind | null;
  navigate: (surface: SurfaceKind) => void;
}): PlanPages {
  const owner = planOwner ?? "main";
  const read = useWorkspaceWork({ rpc, readMoves: readMoves ?? {}, plan, arrival });
  const { work } = read;
  const plans = useMemo(() => work?.plans ?? [], [work]);
  // The pages shown this visit, and the plans the pane reported; a pending plan has its page without either.
  const [visited, setVisited] = useState<readonly string[]>([]);
  const [reportedPages, setReportedPages] = useState<readonly string[]>([]);

  const show = useCallback((ref: PlanPageRef) => navigate(planSurface(ref)), [navigate]);
  const page = planOfSurface(surface);

  // A page keeps its tab once shown, whichever control showed it.
  useEffect(() => {
    if (surface !== null && page !== null) setVisited((held) => (held.includes(surface) ? held : [...held, surface]));
  }, [surface, page]);

  // The plan the pane reports gets its page once per revision, once the read holds it; it takes no surface.
  const reported = plan === null ? null : planSurface({ owner, id: plan.id, revision: plan.revision });

  useEffect(() => {
    if (reported !== null && plans.some((item) => keyOf(item) === reported)) {
      setReportedPages((held) => (held.includes(reported) ? held : [...held, reported]));
    }
  }, [reported, plans]);

  // A new pending plan of this pane's own shows its page: one the read gains after its first answer, or the
  // workspace's own the pane's socket reports. Each revision opens once.
  const known = useRef<ReadonlySet<string> | null>(null);
  const focused = useRef(new Set<string>());

  useEffect(() => {
    if (work === null) return;
    const before = known.current;
    const focus = planFocus ?? null;

    known.current = new Set([...(before ?? []), ...plans.map(keyOf)]);

    const fresh = plans.find((item) => item.plan.status === "pending" && item.owner.name === owner
      && !focused.current.has(keyOf(item))
      && ((before !== null && !before.has(keyOf(item))) || focus === `${item.plan.id}:${String(item.plan.revision)}`));

    if (fresh === undefined) return;
    focused.current.add(keyOf(fresh));
    navigate(keyOf(fresh));
  }, [work, plans, owner, planFocus, navigate]);

  // A plan another pane announced opens here once the read holds it; the claim is the connection's, so a pane that
  // remounts never replays it.
  const announced = arrival?.reference ?? null;

  useEffect(() => {
    if (!arrival || announced === null || work === null) return;

    const item = plans.find((candidate) => candidate.plan.id === announced.id && candidate.plan.revision === announced.revision
      && candidate.owner.name === (announced.path.at(-1) ?? "main"));

    if (item === undefined || !arrival.claim(announced)) return;
    navigate(keyOf(item));
  }, [arrival, announced, work, plans, navigate]);

  const shown = page === null ? undefined : plans.find((item) => sameRevision(item, page));

  // A plan gone from the read closes its page rather than deciding against a plan the workspace no longer holds.
  useEffect(() => {
    if (page !== null && work !== null && shown === undefined) navigate("Work");
  }, [page, shown, work, navigate]);

  const pages = planPages(plans, [...visited, ...reportedPages], surface);

  return { read, owner, pages, drawn: pages.filter((item) => item === shown || visited.includes(keyOf(item))), selected: page !== null, shown, show };
}
