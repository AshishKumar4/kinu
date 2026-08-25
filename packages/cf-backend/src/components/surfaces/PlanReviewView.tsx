import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import {
  CheckCircleIcon, CheckIcon, ChatCircleDotsIcon, CopyIcon, NotePencilIcon,
  TrashIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  admitPlanReviewAnnotations,
  type PlanReview,
  type PlanReviewAnnotation,
  type PlanReviewResult,
} from "@kinu.run/core";
import { Viewer } from "@plannotator/ui/components/Viewer";
import { AnnotationPanel } from "@plannotator/ui/components/AnnotationPanel";
import { AnnotationType, type Annotation, type Block, type EditorMode } from "@plannotator/ui/types";
import {
  exportAnnotations, extractFrontmatter, parseMarkdownToBlocks,
} from "@plannotator/ui/utils/parser";
import type { Rpc } from "@/lib/protocol";
import { createPlanAnnotationSaveQueue } from "./plan-annotation-save";
import { renderThrownChain } from "@kinu.run/core/obs";
import { FilledButton } from "@/components/ui/FilledButton";
import { copyLabel, useCopy } from "@/hooks/use-copy";

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

const FILE_TREE_BRANCH = /^\s*(?:[│|]\s*)*(?:├──|└──|\|--|`--)\s+\S/;

function looksLikeFileTree(content: string): boolean {
  let branches = 0;
  for (const line of content.split("\n")) {
    if (FILE_TREE_BRANCH.test(line) && ++branches === 2) return true;
  }
  return false;
}

/** Images and raw HTML are inert in plan review. The approved source remains
 * byte-for-byte in the durable plan; only the browser renderer is narrowed. */
export function planReviewBlocks(markdown: string): Block[] {
  return parseMarkdownToBlocks(markdown).map((block) => {
    if (block.type === "html") return { ...block, type: "code", language: "html" };
    if (block.type === "code") {
      const plainText = block.language === undefined
        || block.language === ""
        || block.language === "text"
        || block.language === "plaintext";
      return plainText && looksLikeFileTree(block.content) ? { ...block, language: "tree" } : block;
    }
    if (block.type === "math") return block;
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

const STATUS_TONE = {
  pending: "p-badge-warning",
  changes_requested: "p-badge-warning",
  approved: "p-badge-success",
  superseded: "p-badge-neutral",
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
  const [panelOpen, setPanelOpen] = useState(false);
  const { status: copyStatus, copy } = useCopy();
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
    setPanelOpen(false);
    setSaving(false);
    decisionInFlight.current = false;
    setDecisionBusy(null);
    setError(null);
  }, [plan?.id, plan?.revision]);

  const blocks = useMemo(() => planReviewBlocks(plan?.content ?? ""), [plan?.content]);
  const frontmatter = useMemo(() => extractFrontmatter(plan?.content ?? "").frontmatter, [plan?.content]);
  /* A title is the first block or it is not a title. A later h1 stays where
   * the agent wrote it. The header uses Viewer for the promoted block so its
   * Markdown and annotation anchors follow the same path as the document. */
  const titleBlock = useMemo(() => {
    const lead = blocks[0];
    return lead?.type === "heading" && (lead.level ?? 1) === 1 ? lead : null;
  }, [blocks]);
  const titleBlocks = useMemo(() => titleBlock === null ? [] : [titleBlock], [titleBlock]);
  const titleAnnotations = useMemo(
    () => titleBlock === null
      ? []
      : annotations.filter((annotation) => annotation.blockId === titleBlock.id),
    [annotations, titleBlock],
  );
  const documentAnnotations = useMemo(
    () => titleBlock === null
      ? annotations
      : annotations.filter((annotation) => annotation.blockId !== titleBlock.id),
    [annotations, titleBlock],
  );
  const documentBlocks = useMemo(
    () => titleBlock === null ? blocks : blocks.slice(1),
    [blocks, titleBlock],
  );
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

  const addAnnotation = useCallback((annotation: Annotation) => {
    if (decisionInFlight.current) return;
    const next = [...annotations, annotation];
    setSelected(annotation.id);
    setPanelOpen(true);
    changeAnnotations(next);
  }, [annotations, changeAnnotations]);

  const selectAnnotation = useCallback((id: string | null) => {
    setSelected(id);
    if (id !== null) setPanelOpen(true);
  }, []);

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
      <div data-kinu-plan-review className="h-full grid place-items-center p-8">
        <div className="max-w-sm text-center">
          <NotePencilIcon size={30} className="mx-auto mb-3 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">No plan submitted yet</h3>
          <p className="mt-1 text-xs text-muted-foreground">Choose Plan in the composer. The agent will investigate and submit its plan here for review.</p>
        </div>
      </div>
    );
  }

  const closePanel = () => {
    setPanelOpen(false);
    setSelected(null);
  };
  const updatedAt = new Date(plan.updatedAt);

  return (
    <section
      data-kinu-plan-review
      data-plan-review-root
      aria-labelledby="plan-document-title"
      className="relative h-full min-h-0 flex flex-col"
    >
      <header data-plan-header className="p-surface shrink-0 border-b p-border px-4 py-4 sm:px-6 sm:py-5">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="p-eyebrow">Plan</span>
              <span className="p-badge-neutral p-annotation px-2 py-0.5">r{plan.revision}</span>
              <span data-plan-status className={`${STATUS_TONE[plan.status]} px-2 py-0.5`}>{STATUS_LABEL[plan.status]}</span>
            </div>
            {titleBlock === null ? (
              <h1 id="plan-document-title" data-plan-title className="p-display p-text mt-2 text-2xl leading-tight sm:text-3xl">
                Plan
              </h1>
            ) : (
              <div id="plan-document-title" data-plan-title className="p-display p-text mt-2 text-2xl leading-tight sm:text-3xl">
                <Viewer
                  blocks={titleBlocks}
                  markdown={plan.content}
                  annotations={titleAnnotations}
                  onAddAnnotation={addAnnotation}
                  onSelectAnnotation={selectAnnotation}
                  selectedAnnotationId={selected}
                  mode={mode}
                  stickyActions={false}
                  gridEnabled={false}
                  maxWidth={null}
                  readOnly={!editable || decisionBusy !== null}
                />
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <time className="p-annotation p-text-3" dateTime={updatedAt.toISOString()} title={updatedAt.toLocaleString()}>
                Updated {updatedAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </time>
              {saving && <span aria-live="polite" className="p-annotation p-info">Saving annotations…</span>}
            </div>
            {editable && annotations.length === 0 && (
              <p className="p-meta p-text-3 mt-2">Select text to comment or mark it for removal.</p>
            )}
          </div>

          <div data-plan-actions className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => copy(plan.content)}
              icon={copyStatus === "copied"
                ? <CheckIcon size={13} />
                : copyStatus === "failed"
                  ? <WarningCircleIcon size={13} />
                  : <CopyIcon size={13} />}
              aria-live="polite"
            >
              {copyLabel(copyStatus)}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={panelOpen ? "secondary" : "ghost"}
              onClick={() => panelOpen ? closePanel() : setPanelOpen(true)}
              icon={<ChatCircleDotsIcon size={13} />}
              aria-expanded={panelOpen}
              data-plan-annotations-toggle
            >
              Annotations <span className="p-num">{annotations.length}</span>
            </Button>
            {editable && (
              <div className="flex items-center rounded-md border p-border p-recessed p-0.5" aria-label="Annotation mode">
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "comment" ? "secondary" : "ghost"}
                  onClick={() => setMode("comment")}
                  aria-pressed={mode === "comment"}
                  disabled={decisionBusy !== null}
                  icon={<ChatCircleDotsIcon size={12} />}
                >
                  Comment
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={mode === "redline" ? "secondary" : "ghost"}
                  onClick={() => setMode("redline")}
                  aria-pressed={mode === "redline"}
                  disabled={decisionBusy !== null}
                  icon={<TrashIcon size={12} />}
                >
                  Remove
                </Button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div data-plan-body className="relative flex flex-1 min-h-0">
        <div data-plan-scroll className="flex-1 min-w-0 overflow-y-auto px-4 py-8 sm:px-8 sm:py-10">
          <div data-plan-document className="plan-review-document mx-auto">
            <Viewer
              blocks={documentBlocks}
              markdown={plan.content}
              frontmatter={frontmatter}
              annotations={documentAnnotations}
              onAddAnnotation={addAnnotation}
              onSelectAnnotation={selectAnnotation}
              selectedAnnotationId={selected}
              mode={mode}
              stickyActions={false}
              gridEnabled={false}
              maxWidth={null}
              readOnly={!editable || decisionBusy !== null}
            />
          </div>
        </div>
        {panelOpen && (
          <button
            type="button"
            data-plan-scrim
            aria-label="Close annotations"
            className="p-scrim"
            onClick={closePanel}
          />
        )}
        <AnnotationPanel
          isOpen={panelOpen}
          annotations={annotations}
          selectedId={selected}
          onSelect={setSelected}
          onDelete={(id) => {
            if (selected === id) setSelected(null);
            changeAnnotations(annotations.filter((annotation) => annotation.id !== id));
          }}
          onEdit={(id, updates) => changeAnnotations(annotations.map((annotation) => annotation.id === id ? { ...annotation, ...updates } : annotation))}
          onClose={closePanel}
          readOnly={!editable || decisionBusy !== null}
          width="min(var(--plan-rail-width), 100%)"
        />
      </div>

      <footer data-plan-footer className="p-surface shrink-0 border-t p-border px-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {error ? (
            <p role="alert" className="p-notice-danger p-meta px-3 py-2 sm:mr-auto">{error}</p>
          ) : (
            <p className="p-meta p-text-3 sm:mr-auto">
              {editable
                ? "Approve this revision, or annotate the exact text that needs work."
                : handoffPending
                  ? plan.status === "approved" ? "Approval is saved; implementation has not started." : "Your review is saved; the revision turn has not started."
                  : plan.status === "approved" ? "Implementation started from this revision." : "The agent is preparing the next revision."}
            </p>
          )}
          {editable && (
            <div data-plan-decisions className="grid grid-cols-2 gap-2 sm:flex">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void decide("request_changes")}
                disabled={decisionBusy !== null || saving || annotations.length === 0}
              >
                {decisionBusy === "request" ? <Loader size="sm" /> : "Request changes"}
              </Button>
              <FilledButton
                className="w-full sm:w-auto"
                onClick={() => void decide("approve")}
                disabled={decisionBusy !== null || saving || annotations.length > 0}
              >
                {decisionBusy === "approve" ? <Loader size="sm" /> : <><CheckCircleIcon size={14} />Approve &amp; implement</>}
              </FilledButton>
            </div>
          )}
          {handoffPending && (
            <FilledButton
              onClick={() => void decide(plan.status === "approved" ? "approve" : "request_changes")}
              disabled={decisionBusy !== null || saving}
            >
              {decisionBusy ? <Loader size="sm" /> : plan.status === "approved" ? "Retry implementation" : "Retry revision"}
            </FilledButton>
          )}
        </div>
      </footer>
    </section>
  );
}
