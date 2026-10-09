/** A plan's own page in the inspector: its newest revision, reviewed where it is read. */
import { lazy, Suspense } from "react";
import { Loader } from "@cloudflare/kumo";
import type { OwnedPlan, Rpc, WorkspaceWork } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import type { AsyncResource } from "@/hooks/use-async-resource";

const PlanReviewView = lazy(() => import("./PlanReviewView"));

/** Its owner decides it from its own pane; anyone else reads it. */
export function PlanPage({ item, owner, rpc, planRpc, onReviewActor, resource, onRetry }: {
  item: OwnedPlan;
  owner: string;
  rpc: Rpc;
  planRpc: Rpc;
  onReviewActor?: (name: string, actorId?: string) => void | Promise<void>;
  resource: AsyncResource<WorkspaceWork>;
  onRetry: () => void;
}) {
  const mine = item.owner.name === owner;

  return (
    <div data-plan-page={`${item.owner.name}:${item.plan.id}`} className="flex h-full min-h-0 flex-col space-y-3 animate-fade-in">
      {!mine && (
        <span className="flex min-w-0 shrink-0 flex-col items-start gap-0.5 p-meta p-text-3">Read-only: {item.owner.name}'s plan
          {onReviewActor && <button type="button" className="text-left p-accent" onClick={() => void onReviewActor(item.owner.name)}>Review in {item.owner.name}'s conversation</button>}
        </span>
      )}
      {resource.status === "error" && (
        <LoadFailure what="the workspace's work" message={resource.message} onRetry={onRetry} />
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="flex justify-center py-8"><Loader size="sm" /></div>}>
          <PlanReviewView plan={item.plan} rpc={item.owner.name === "main" ? rpc : planRpc} readOnly={!mine || item.owner.retired || item.plan.status !== "pending"}
            {...(item.owner.name !== "main" && { agentName: item.owner.name })} />
        </Suspense>
      </div>
    </div>
  );
}
