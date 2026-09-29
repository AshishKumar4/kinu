import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Annotation } from '@plannotator/ui/types';
import { AnnotationType } from '@plannotator/ui/types';
import { useIsMobile } from '@plannotator/ui/hooks/useIsMobile';

interface PanelProps {
  isOpen: boolean;
  annotations: Annotation[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit?: (id: string, updates: Partial<Annotation>) => void;
  selectedId: string | null;
  width?: number | string;
  onClose?: () => void;
  readOnly?: boolean;
  /** Where a note sits, for hosts whose notes are not in the text beside the panel (a diff's file and lines). */
  placeOf?: (annotation: Annotation) => ReactNode;
  /** Offered while the host has no note on the whole document yet. */
  onAddGlobal?: () => void;
  globalLabel?: string;
}

const COMMENT_KIND = { label: 'Comment', color: 'text-annotation-comment' } as const;

/** A note's heading and its colour; every type not named here reads as a comment. */
const ANNOTATION_KIND: Partial<Record<AnnotationType, { readonly label: string; readonly color: string }>> = {
  [AnnotationType.DELETION]: { label: 'Remove', color: 'text-destructive' },
  [AnnotationType.GLOBAL_COMMENT]: { label: 'Global', color: 'text-purple-500' },
};

const annotationKind = (type: AnnotationType) => ANNOTATION_KIND[type] ?? COMMENT_KIND;

interface CardProps {
  annotation: Annotation;
  selected: boolean;
  readOnly: boolean;
  place?: ReactNode;
  onSelect: () => void;
  onDelete: () => void;
  onEdit?: (updates: Partial<Annotation>) => void;
}

const AnnotationCard = ({
  annotation,
  selected,
  readOnly,
  place,
  onSelect,
  onDelete,
  onEdit,
}: CardProps) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(annotation.text ?? '');

  useEffect(() => setText(annotation.text ?? ''), [annotation.text]);

  const save = () => {
    const next = text.trim();

    if (!next || !onEdit) return;
    onEdit({ text: next });
    setEditing(false);
  };

  return (
    <article
      data-annotation-id={annotation.id}
      className={`rounded-lg border p-3 transition-colors ${selected ? 'border-primary bg-primary/5' : 'border-border/50 bg-background/40 hover:border-border'}`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <span className={`text-[10px] font-semibold uppercase tracking-wide ${annotationKind(annotation.type).color}`}>
          {annotationKind(annotation.type).label}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {new Date(annotation.createdA).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      {place !== undefined && place !== null && (
        <div data-annotation-place className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground">{place}</div>
      )}
      {annotation.originalText && (
        <blockquote className="mt-2 line-clamp-3 border-l-2 border-border pl-2 text-[11px] text-muted-foreground">
          {annotation.originalText}
        </blockquote>
      )}
      {editing ? (
        <div className="mt-2" onClick={(event) => event.stopPropagation()}>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-ring"
            autoFocus
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted" onClick={() => { setText(annotation.text ?? ''); setEditing(false); }}>Cancel</button>
            <button type="button" className="rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40" disabled={!text.trim()} onClick={save}>Save</button>
          </div>
        </div>
      ) : annotation.text && (
        <p className="mt-2 whitespace-pre-wrap text-xs text-foreground/90">{annotation.text}</p>
      )}
      {!readOnly && !editing && (
        <div className="mt-2 flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          {annotation.type !== AnnotationType.DELETION && onEdit && (
            <button type="button" className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setEditing(true)}>Edit</button>
          )}
          <button type="button" className="rounded px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10" onClick={onDelete}>Delete</button>
        </div>
      )}
    </article>
  );
};

export const AnnotationPanel = ({
  isOpen,
  annotations,
  onSelect,
  onDelete,
  onEdit,
  selectedId,
  width,
  onClose,
  readOnly = false,
  placeOf,
  onAddGlobal,
  globalLabel = 'Add a global comment',
}: PanelProps) => {
  const isMobile = useIsMobile();
  const listRef = useRef<HTMLDivElement>(null);
  const sorted = [...annotations].sort((left, right) => left.createdA - right.createdA);

  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector(`[data-annotation-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [selectedId]);

  if (!isOpen) return null;

  const panel = (
    <aside
      data-annotation-panel="true"
      className={`flex shrink-0 flex-col border-l border-border/50 bg-card ${isMobile ? 'fixed inset-y-0 right-0 z-[60] w-full max-w-sm shadow-2xl' : ''}`}
      style={isMobile ? undefined : { width: width ?? 288 }}
    >
      <div className="flex h-11 items-center justify-between border-b border-border/50 px-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium text-foreground">Annotations</h2>
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">{annotations.length}</span>
        </div>
        {isMobile && onClose && (
          <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onClose} aria-label="Close annotations">×</button>
        )}
      </div>
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        {sorted.length === 0 && !onAddGlobal ? (
          <div className="grid flex-1 place-items-center px-4 text-center">
            <div><p className="text-xs text-muted-foreground">No annotations yet</p><p className="mt-1 text-[11px] text-muted-foreground/70">Select text to annotate</p></div>
          </div>
        ) : sorted.map((annotation) => (
          <AnnotationCard
            key={annotation.id}
            annotation={annotation}
            selected={selectedId === annotation.id}
            readOnly={readOnly}
            place={placeOf?.(annotation)}
            onSelect={() => onSelect(annotation.id)}
            onDelete={() => onDelete(annotation.id)}
            onEdit={onEdit ? (updates) => onEdit(annotation.id, updates) : undefined}
          />
        ))}
        {onAddGlobal && !readOnly && (
          <button
            type="button"
            data-annotation-add-global
            className="rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
            onClick={onAddGlobal}
          >
            {globalLabel}
          </button>
        )}
      </div>
    </aside>
  );

  if (!isMobile) return panel;

  return (
    <>
      <div className="fixed inset-0 z-[59] bg-background/60 backdrop-blur-sm" onClick={onClose} />
      {panel}
    </>
  );
};
