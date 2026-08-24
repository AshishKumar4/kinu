/**
 * The demo's plan surface: the REAL plan renderer — @plannotator's Viewer fed
 * through `planReviewBlocks`, under `[data-kinu-plan-review]` so the product's
 * token bridge and highlight styles apply — with the product's plan-review
 * chrome around it, driven by the timeline instead of RPC state. Loaded
 * lazily: the landing's first paint does not pay for marked/katex/dompurify.
 *
 * The footer buttons keep the product's enabling rule: annotations present
 * means only "Request changes" is live; a clean revision enables "Approve".
 */
import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { CheckCircleIcon, ChatCircleDotsIcon } from '@phosphor-icons/react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';

import { planReviewBlocks } from '@/components/surfaces/PlanReviewView';

import type { DemoPlan, DemoPlanStatus } from './bugfix-demo-timeline';

const STATUS_LABEL = {
  pending: 'Awaiting review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
} satisfies Record<DemoPlanStatus, string>;

export default function BugFixPlanPanel({ plan }: { plan: DemoPlan }): ReactElement {
  const docRef = useRef<HTMLDivElement | null>(null);
  const blocks = useMemo(() => planReviewBlocks(plan.markdown), [plan.markdown]);
  const annotations = useMemo<Annotation[]>(() => plan.annotations.map((note) => ({
    id: note.id,
    blockId: '',
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: note.note,
    originalText: note.anchor,
    createdA: 0,
    author: 'You',
  })), [plan.annotations]);
  const approved = plan.status === 'approved';

  // A reviewer scrolls to the line they are annotating; so does the demo.
  // The highlight lands asynchronously (the Viewer paints on a zero timeout),
  // so watch for it and reveal it the moment it exists. A revision with no
  // annotations reads from the top.
  useEffect(() => {
    const doc = docRef.current;
    if (doc === null) return;
    if (plan.annotations.length === 0) {
      doc.scrollTop = 0;
      return;
    }
    const reveal = (): boolean => {
      const highlight = doc.querySelector('.annotation-highlight');
      if (highlight === null) return false;
      const box = highlight.getBoundingClientRect();
      const view = doc.getBoundingClientRect();
      if (box.bottom > view.bottom - 24) doc.scrollTop += Math.ceil(box.bottom - view.bottom) + 56;
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    observer.observe(doc, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [plan.annotations.length]);
  return (
    <div
      data-kinu-plan-review
      data-demo-plan
      data-demo-plan-revision={plan.revision}
      data-demo-plan-status={plan.status}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium text-foreground">Plan</span>
        <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">r{plan.revision}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${approved ? 'bg-success/15 text-success' : 'bg-primary/10 text-primary'}`}>
          {STATUS_LABEL[plan.status]}
        </span>
        {plan.revision === 2 && (
          <span className="text-[10px] text-muted-foreground">Revised after your note</span>
        )}
      </div>
      <div ref={docRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-2 md:px-6">
        <Viewer
          blocks={blocks}
          markdown={plan.markdown}
          annotations={annotations}
          onAddAnnotation={() => {}}
          onSelectAnnotation={() => {}}
          selectedAnnotationId={annotations[0]?.id ?? null}
          mode="comment"
          stickyActions={false}
          gridEnabled={false}
          maxWidth={null}
          readOnly
          copyLabel="Copy plan"
        />
      </div>
      {annotations.length > 0 && (
        <div data-demo-note className="flex shrink-0 items-start gap-2 border-t border-dashed border-border px-3 py-2">
          <ChatCircleDotsIcon size={13} className="mt-0.5 shrink-0 text-primary" />
          <p className="min-w-0 text-[11.5px] leading-[1.5] text-muted-foreground">
            <span className="font-medium text-foreground">You</span> · {annotations[0]?.text}
          </p>
        </div>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-card px-3 py-2">
        <p className="mr-auto text-[11px] text-muted-foreground">
          {approved
            ? 'Implementation was started from this approved revision.'
            : 'Annotate the exact lines that need work, or approve the plan as written.'}
        </p>
        <button
          type="button"
          data-demo-target="request-changes"
          disabled={annotations.length === 0}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-40"
        >
          Request changes
        </button>
        <button
          type="button"
          data-demo-target="approve"
          disabled={annotations.length > 0}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
        >
          <CheckCircleIcon size={14} />Approve &amp; implement
        </button>
      </div>
    </div>
  );
}
