import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Annotation } from '@plannotator/ui/types';
import { AnnotationType } from '@plannotator/ui/types';
import { useIsMobile } from '@plannotator/ui/hooks/useIsMobile';
import { TextArea } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { XIcon } from '@phosphor-icons/react';
import { Badge } from '@/components/ui/Badge';
import { Drawer } from '@/components/ui/Drawer';

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
  /** What the panel calls its notes. */
  title?: string;
  /** A note the reviewer cannot edit or delete, though the rest are open. */
  isLocked?: (annotation: Annotation) => boolean;
  /** The note's thread, shown under it. */
  renderThread?: (annotation: Annotation) => ReactNode;
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
  thread?: ReactNode;
  onSelect: () => void;
  onDelete: () => void;
  onEdit?: (updates: Partial<Annotation>) => void;
}

const AnnotationCard = ({
  annotation,
  selected,
  readOnly,
  place,
  thread,
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
      data-selected={selected ? '' : undefined}
      className="p-3"
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <span className={`t-micro uppercase ${annotationKind(annotation.type).color}`}>
          {annotationKind(annotation.type).label}
        </span>
        <span className="t-meta ml-auto text-muted-foreground">
          {new Date(annotation.createdA).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      {place !== undefined && place !== null && (
        <div data-annotation-place className="t-meta t-mono mt-1 truncate text-muted-foreground">{place}</div>
      )}
      {annotation.originalText && (
        <blockquote className="t-meta mt-2 line-clamp-3 border-l-2 p-border pl-2 text-muted-foreground">
          {annotation.originalText}
        </blockquote>
      )}
      {editing ? (
        <div className="mt-2" onClick={(event) => event.stopPropagation()}>
          <TextArea className="min-h-20 w-full resize-y" value={text} onChange={(event) => setText(event.target.value)} autoFocus />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setText(annotation.text ?? ''); setEditing(false); }}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={!text.trim()} onClick={save}>Save</Button>
          </div>
        </div>
      ) : annotation.text && (
        <p className="t-meta mt-2 whitespace-pre-wrap text-foreground/90">{annotation.text}</p>
      )}
      {thread}
      {!readOnly && !editing && (
        <div className="mt-2 flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          {annotation.type !== AnnotationType.DELETION && onEdit && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
          )}
          <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
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
  title = 'Annotations',
  isLocked,
  renderThread,
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
      className={`flex shrink-0 flex-col bg-card ${isMobile ? 'h-full' : 'border-l p-border'}`}
      style={isMobile ? undefined : { width: width ?? 288 }}
    >
      <div className="flex h-11 items-center justify-between border-b p-border px-3">
        <div className="flex items-center gap-2">
          <h2 className="t-status text-foreground">{title}</h2>
          <Badge tone="accent">{annotations.length}</Badge>
        </div>
        {isMobile && onClose && (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} icon={<XIcon size={14} />} />
        )}
      </div>
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {sorted.length === 0 && !onAddGlobal ? (
          <div className="grid flex-1 place-items-center px-4 text-center">
            <div><p className="t-meta text-muted-foreground">No {title.toLowerCase()} yet</p><p className="t-meta mt-1 text-muted-foreground/70">Select text to annotate</p></div>
          </div>
        ) : sorted.map((annotation) => (
          <AnnotationCard
            key={annotation.id}
            annotation={annotation}
            selected={selectedId === annotation.id}
            readOnly={readOnly || isLocked?.(annotation) === true}
            place={placeOf?.(annotation)}
            thread={renderThread?.(annotation)}
            onSelect={() => onSelect(annotation.id)}
            onDelete={() => onDelete(annotation.id)}
            onEdit={onEdit ? (updates) => onEdit(annotation.id, updates) : undefined}
          />
        ))}
        {onAddGlobal && !readOnly && (
          <Button variant="ghost" size="sm" data-annotation-add-global onClick={onAddGlobal}>
            {globalLabel}
          </Button>
        )}
      </div>
    </aside>
  );

  if (!isMobile) return panel;

  return <Drawer onClose={() => onClose?.()}>{panel}</Drawer>;
};
