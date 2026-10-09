/** Which plans have a page tab, which one is shown, and the ways a plan's page opens. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NotePencilIcon } from "@phosphor-icons/react";
import { planOfSurface, planSurface, planTitle, type OwnedPlan, type PlanPageRef, type PlanReview, type Rpc, type SurfaceKind } from "@kinu.run/core";
import type { PageTab } from "./InspectorBar";
import type { ReadMoves, WorkspacePlanArrival } from "@/hooks/use-kinu";
import { useWorkspaceWork, type WorkspaceWorkRead } from "./use-workspace-work";

const refOf = (item: OwnedPlan): PlanPageRef => ({ owner: item.owner.name, id: item.plan.id, revision: item.plan.revision });

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
    const page = planSurface(refOf(item));
    const latest = newest.get(`${item.owner.name}\u0000${item.plan.id}`) === item.plan.revision;

    return page === surface || (latest && (item.plan.status === "pending" || opened.includes(page)));
  });
}

export interface PlanPages {
  /** The column's one read of plans and tasks. */
  readonly read: WorkspaceWorkRead;
  /** Whose plans this pane decides: the others' it reads. */
  readonly owner: string;
  /** A page tab for each plan with a page, in the read's order. */
  readonly tabs: readonly PageTab[];
  /** The plan the shown surface is the page of. */
  readonly shown: OwnedPlan | undefined;
  /** Opens a plan's page and shows it. */
  readonly show: (plan: PlanPageRef) => void;
}

export function usePlanPages({ rpc, readMoves, plan, planOwner, planFocus, arrival, surface, navigate }: {
  rpc: Rpc;
  readMoves: ReadMoves | undefined;
  /** The plan the pane reports, its owner's. */
  plan: PlanReview | null;
  planOwner: string | undefined;
  /** `id:revision` of a new pending plan of the workspace's own. */
  planFocus: string | null | undefined;
  arrival: WorkspacePlanArrival | null | undefined;
  surface: SurfaceKind | null;
  navigate: (surface: SurfaceKind) => void;
}): PlanPages {
  const owner = planOwner ?? "main";
  const read = useWorkspaceWork({ rpc, readMoves: readMoves ?? {}, plan, arrival });
  const plans = useMemo(() => read.work?.plans ?? [], [read.work]);
  // The plans the reader or the workspace opened this visit; a pending plan has its page without being opened.
  const [opened, setOpened] = useState<readonly string[]>([]);

  const open = useCallback((ref: PlanPageRef, show: boolean) => {
    const key = planSurface(ref);

    setOpened((held) => (held.includes(key) ? held : [...held, key]));

    if (show) navigate(key);
  }, [navigate]);

  const show = useCallback((ref: PlanPageRef) => open(ref, true), [open]);
  const reported = plan === null ? null : `${plan.id}:${String(plan.revision)}`;
  const openedReported = useRef<string | null>(null);

  // The plan the pane reports gets its page once per revision, once the read holds it; it takes no surface.
  useEffect(() => {
    if (reported === null || plan === null || openedReported.current === reported) return;
    const ref = { owner, id: plan.id, revision: plan.revision };

    if (!plans.some((item) => sameRevision(item, ref))) return;
    openedReported.current = reported;
    open(ref, false);
  }, [reported, plan, plans, owner, open]);

  // A new pending plan of the workspace's own opens its page on the workspace's pane, whose owner is the root's
  // registered name, once the read holds it.
  const focused = useRef<string | null>(null);

  useEffect(() => {
    const key = planFocus ?? null;
    const cut = key?.lastIndexOf(":") ?? -1;

    if (key === null || cut < 0 || focused.current === key) return;
    const ref = { owner, id: key.slice(0, cut), revision: Number(key.slice(cut + 1)) };

    if (!plans.some((item) => sameRevision(item, ref))) return;
    focused.current = key;
    open(ref, true);
  }, [planFocus, plans, owner, open]);

  const page = planOfSurface(surface);
  const shown = page === null ? undefined : plans.find((item) => sameRevision(item, page));

  // A plan gone from the read closes its page rather than deciding against a plan the workspace no longer holds.
  useEffect(() => {
    if (page !== null && read.work !== null && shown === undefined) navigate("Work");
  }, [page, shown, read.work, navigate]);

  const tabs = planPages(plans, opened, surface).map((item): PageTab => ({
    key: planSurface(refOf(item)), title: planTitle(item.plan.content), Icon: NotePencilIcon,
  }));

  return { read, owner, tabs, shown, show };
}
