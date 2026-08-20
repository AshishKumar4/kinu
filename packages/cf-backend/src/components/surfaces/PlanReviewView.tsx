import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader } from "@cloudflare/kumo";
import {
  CheckCircleIcon, ChatCircleDotsIcon, NotePencilIcon, TrashIcon,
} from "@phosphor-icons/react";
import {
  admitPlanReviewAnnotations,
  type PlanReview,
  type PlanReviewAnnotation,
  type PlanReviewResult,
} from "@kinu/core";
import { Viewer } from "@plannotator/ui/components/Viewer";
import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";
import { AnnotationType, type Annotation, type Block, type EditorMode } from "@plannotator/ui/types";
import {
  exportAnnotations, extractFrontmatter, parseMarkdownToBlocks,
} from "@plannotator/ui/utils/parser";
import type { Rpc } from "@/lib/protocol";
import { createPlanAnnotationSaveQueue } from "./plan-annotation-save";
import { renderThrownChain } from "@kinu/core/obs";

function annotationType(value: PlanReviewAnnotation["type"]): AnnotationType {
  if (value === "DELETION") return AnnotationType.DELETION;
  if (value === "GLOBAL_COMMENT") return AnnotationType.GLOBAL_COMMENT;
  return AnnotationType.COMMENT;
}

export function parsePlanAnnotations<Values>(values: Values): Annotation[] {
  const admission = admitPlanReviewAnnotations(values);
  if (!admission.ok) return [];
  return admission.annotations.map((annotation) => ({
    ...annotation,
    type: annotationType(annotation.type),
    author: annotation.author ?? "Owner",
    mathTargets: annotation.mathTargets ? [...annotation.mathTargets] : undefined,
  }));
}

/** Images and raw HTML are inert in plan review. The approved source remains
 * byte-for-byte in the durable plan; only the browser renderer is narrowed. */
export function planReviewBlocks(markdown: string): Block[] {
  return parseMarkdownToBlocks(markdown).map((block) => {
    if (block.type === "html") return { ...block, type: "code", language: "html" };
    if (block.type === "code" || block.type === "math") return block;
    return { ...block, content: omitMarkdownImages(block.content) };
  });
}

function omitMarkdownImages(markdown: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < markdown.length) {
    const start = markdown.indexOf("![", cursor);
    if (start < 0) return output + markdown.slice(cursor);
    output += markdown.slice(cursor, start);
    const labelEnd = markdown.indexOf("](", start + 2);
    if (labelEnd < 0) { output += markdown.slice(start); break; }
    let end = labelEnd + 2;
    let depth = 1;
    for (; end < markdown.length && depth > 0; end++) {
      if (markdown[end] === "\\") { end++; continue; }
      if (markdown[end] === "(") depth++;
      if (markdown[end] === ")") depth--;
    }
    if (depth !== 0) { output += markdown.slice(start); break; }
    const alt = markdown.slice(start + 2, labelEnd).trim();
    output += alt ? `[Image omitted: ${alt}]` : "[Image omitted]";
    cursor = end;
  }
  return output;
}

const STATUS_LABEL = {
  pending: "Awaiting review",
  changes_requested: "Revision requested",
  approved: "Approved",
  superseded: "Superseded",
} satisfies Record<PlanReview["status"], string>;

export interface PlanReviewViewProps {
  plan: PlanReview | null;
  rpc: Rpc;
}

export default function PlanReviewView({ plan, rpc }: PlanReviewViewProps) {
  const [annotations, setAnnotations] = useState<Annotation[]>(() => parsePlanAnnotations(plan?.annotations ?? []));
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>("comment");
  const [saving, setSaving] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState<"request" | "approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(() => globalThis.window === undefined || !globalThis.window.matchMedia("(max-width: 767px)").matches);
  const planId = plan?.id ?? null;
  const planRevision = plan?.revision ?? null;
  const planKey = planId === null || planRevision === null ? null : `${planId}:${planRevision}`;
  const activePlanKey = useRef(planKey);
  const decisionInFlight = useRef(false);
  activePlanKey.current = planKey;

  const annotationSaves = useMemo(() => createPlanAnnotationSaveQueue<Annotation>(async (next) => {
    if (planId === null || planRevision === null) return false;
    if (activePlanKey.current === planKey) setError(null);
    try {
      const result = await rpc<PlanReviewResult>("savePlanReviewAnnotations", [planId, planRevision, next]);
      if (!result.ok) {
        if (activePlanKey.current === planKey) setError(result.error);
        return false;
      }
      return true;
    } catch (cause) {
      if (activePlanKey.current === planKey) {
        setError(renderThrownChain({ cause: cause }));
      }
      return false;
    }
  }), [planId, planKey, planRevision, rpc]);

  useEffect(() => {
    setAnnotations(parsePlanAnnotations(plan?.annotations ?? []));
    setSelected(null);
    setSaving(false);
    decisionInFlight.current = false;
    setDecisionBusy(null);
    setError(null);
  }, [plan?.id, plan?.revision]);

  useEffect(() => {
    if (globalThis.window === undefined) return;
    const media = globalThis.window.matchMedia("(max-width: 767px)");
    const sync = () => setPanelOpen(!media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const blocks = useMemo(() => planReviewBlocks(plan?.content ?? ""), [plan?.content]);
  const frontmatter = useMemo(() => extractFrontmatter(plan?.content ?? "").frontmatter, [plan?.content]);
  const editable = plan?.status === "pending";
  const handoffPending = plan != null && !plan.handoffAccepted
    && (plan.status === "approved" || plan.status === "changes_requested");

  const save = useCallback(async (next: Annotation[]): Promise<boolean> => {
    if (planKey === null) return false;
    setAnnotations(next);
    setSaving(true);
    const saved = await annotationSaves.enqueue(next);
    if (annotationSaves.pending() === 0 && activePlanKey.current === planKey) {
      setSaving(false);
    }
    return saved;
  }, [annotationSaves, planKey]);

  const changeAnnotations = useCallback((next: Annotation[]) => {
    if (decisionInFlight.current) return;
    void save(next);
  }, [save]);

  const decide = useCallback(async (decision: "request_changes" | "approve") => {
    if (!plan || (!editable && !handoffPending) || decisionInFlight.current) return;
    decisionInFlight.current = true;
    setDecisionBusy(decision === "approve" ? "approve" : "request");
    setError(null);
    try {
      if (editable) {
        const saved = await save(annotations);
        if (!saved) return;
      }
      const feedback = editable && decision === "request_changes"
        ? exportAnnotations(blocks, annotations, [], "Plan Feedback", "plan")
        : undefined;
      const result = await rpc<PlanReviewResult & { queued?: boolean; queueError?: string }>(
        "decidePlanReview", [plan.id, plan.revision, decision, feedback],
      );
      if (!result.ok) throw new Error(result.error);
      if (result.queued === false) {
        setError(`Decision saved, but the next turn could not start${result.queueError ? `: ${result.queueError}` : "."}`);
      }
    } catch (cause) {
      setError(renderThrownChain({ cause: cause }));
    } finally {
      decisionInFlight.current = false;
      setDecisionBusy(null);
    }
  }, [annotations, blocks, editable, handoffPending, plan, rpc, save]);

  if (!plan) {
    return (
      <div data-proteus-plan-review className="h-full grid place-items-center p-8">
        <div className="max-w-sm text-center">
          <NotePencilIcon size={30} className="mx-auto mb-3 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">No plan submitted yet</h3>
          <p className="mt-1 text-xs text-muted-foreground">Choose Plan in the composer. The agent will investigate and submit its plan here for review.</p>
        </div>
      </div>
    );
  }

  return (
    <div data-proteus-plan-review className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 mr-auto">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">Plan</span>
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">r{plan.revision}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${plan.status === "approved" ? "bg-success/15 text-success" : "bg-primary/10 text-primary"}`}>
              {STATUS_LABEL[plan.status]}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">{saving ? "Saving annotations…" : `Updated ${new Date(plan.updatedAt).toLocaleString()}`}</p>
        </div>
        {editable && (
          <div className="flex items-center rounded-lg border border-border bg-muted/40 p-0.5" aria-label="Annotation mode">
            <button onClick={() => setMode("comment")} aria-pressed={mode === "comment"} disabled={decisionBusy !== null}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${mode === "comment" ? "bg-card text-foreground" : "text-muted-foreground"}`}>
              <ChatCircleDotsIcon size={12} />Comment
            </button>
            <button onClick={() => setMode("redline")} aria-pressed={mode === "redline"} disabled={decisionBusy !== null}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${mode === "redline" ? "bg-card text-foreground" : "text-muted-foreground"}`}>
              <TrashIcon size={12} />Remove
            </button>
          </div>
        )}
        <button onClick={() => setPanelOpen((open) => !open)} className="md:hidden rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
          {annotations.length} note{annotations.length === 1 ? "" : "s"}
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-y-auto px-5 py-6 md:px-8">
          <div className="mx-auto max-w-[52rem]">
            <Viewer
              blocks={blocks}
              markdown={plan.content}
              frontmatter={frontmatter}
              annotations={annotations}
              onAddAnnotation={(annotation) => {
                if (decisionInFlight.current) return;
                const next = [...annotations, annotation];
                setSelected(annotation.id);
                setPanelOpen(true);
                changeAnnotations(next);
              }}
              onSelectAnnotation={setSelected}
              selectedAnnotationId={selected}
              mode={mode}
              stickyActions
              gridEnabled={false}
              maxWidth={null}
              readOnly={!editable || decisionBusy !== null}
              copyLabel="Copy plan"
            />
          </div>
        </div>
        <AnnotationPanel
          isOpen={panelOpen}
          annotations={annotations}
          selectedId={selected}
          onSelect={setSelected}
          onDelete={(id) => changeAnnotations(annotations.filter((annotation) => annotation.id !== id))}
          onEdit={(id, updates) => changeAnnotations(annotations.map((annotation) => annotation.id === id ? { ...annotation, ...updates } : annotation))}
          onClose={() => setPanelOpen(false)}
          readOnly={!editable || decisionBusy !== null}
          width={300}
        />
      </div>

      <div className="shrink-0 flex flex-wrap items-center gap-2 border-t border-border bg-card px-3 py-2">
        {error ? <p role="alert" className="mr-auto text-xs text-destructive">{error}</p> : (
          <p className="mr-auto text-[11px] text-muted-foreground">
            {editable
              ? "Annotate the exact lines that need work, or approve the plan as written."
              : handoffPending
                ? plan.status === "approved" ? "Approval is saved; implementation has not started." : "Your review is saved; the revision turn has not started."
                : plan.status === "approved" ? "Implementation was started from this approved revision." : "The agent is preparing the next revision."}
          </p>
        )}
        {editable && (
          <>
            <button onClick={() => void decide("request_changes")} disabled={decisionBusy !== null || saving || annotations.length === 0}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-40">
              {decisionBusy === "request" ? <Loader size="sm" /> : "Request changes"}
            </button>
            <button onClick={() => void decide("approve")} disabled={decisionBusy !== null || saving || annotations.length > 0}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40">
              {decisionBusy === "approve" ? <Loader size="sm" /> : <><CheckCircleIcon size={14} />Approve &amp; implement</>}
            </button>
          </>
        )}
        {handoffPending && (
          <button
            onClick={() => void decide(plan.status === "approved" ? "approve" : "request_changes")}
            disabled={decisionBusy !== null || saving}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
          >
            {decisionBusy ? <Loader size="sm" /> : plan.status === "approved" ? "Retry implementation" : "Retry revision"}
          </button>
        )}
      </div>
    </div>
  );
}
