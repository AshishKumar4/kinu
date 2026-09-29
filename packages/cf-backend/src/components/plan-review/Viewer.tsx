import * as v from 'valibot';
import { settleLogged } from '@kinu.run/core/obs';
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { Marked, type RendererObject } from 'marked';
import { AnnotationType, type Annotation, type Block, type EditorMode } from '@plannotator/ui/types';
import { computeListIndices, groupBlocks, type Frontmatter, type FrontmatterValue } from '@plannotator/ui/utils/parser';
import { buildHeadingSlugMap } from '@plannotator/ui/utils/slugify';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { useAnnotationHighlighter } from '@plannotator/ui/hooks/useAnnotationHighlighter';

interface ViewerProps {
  blocks: Block[];
  markdown: string;
  frontmatter?: Frontmatter | null;
  annotations: Annotation[];
  onAddAnnotation: (annotation: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  stickyActions?: boolean;
  gridEnabled?: boolean;
  maxWidth?: number | null;
  copyLabel?: string;
  readOnly?: boolean;
}

export interface ViewerHandle {
  removeHighlight: (id: string) => void;
  clearAllHighlights: () => void;
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

const annotationId = (): string => crypto.randomUUID();

/** A value as one line of text: a list joined by commas, a map as `key: value` pairs. */
const frontmatterText = (value: FrontmatterValue): string => {
  if (v.is(v.string(), value)) return value;

  if (Array.isArray(value)) return value.map(frontmatterText).join(', ');

  return Object.entries(value).map(([key, inner]) => `${key}: ${frontmatterText(inner)}`).join(', ');
};

const FrontmatterCard = ({ frontmatter }: { frontmatter: Frontmatter }) => {
  const entries = Object.entries(frontmatter);

  if (entries.length === 0) return null;

  return (
    <div className="mt-4 mb-6 rounded-lg border border-border/50 bg-muted/30 p-4">
      <div className="grid gap-2 text-sm">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <span className="min-w-[80px] font-medium text-muted-foreground">{key}:</span>
            <span className="text-foreground">
              {frontmatterText(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

const INLINE_TAGS = ['a', 'br', 'code', 'del', 'em', 's', 'span', 'strong', 'sub', 'sup'];

const INLINE_ATTRIBUTES = ['href', 'rel', 'target', 'title'];

const escapeAttribute = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const planInlineRenderer: RendererObject = {
  link(token): string {
    const label = this.parser.parseInline(token.tokens);
    const href = token.href.trim();

    if (!href.startsWith('#') && !/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) {
      return label;
    }

    const title = token.title ? ` title="${escapeAttribute(token.title)}"` : '';
    const external = href.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"';

    return `<a href="${escapeAttribute(href)}"${title}${external}>${label}</a>`;
  },
};

const planInlineMarked = new Marked({ renderer: planInlineRenderer });

const PlanInlineMarkdown = React.memo(({ text }: { text: string }) => {
  const html = useMemo(() => {
    const rendered = planInlineMarked.parseInline(text, {
      async: false,
      gfm: true,
    });

    return DOMPurify.sanitize(rendered, {
      ALLOWED_TAGS: INLINE_TAGS,
      ALLOWED_ATTR: INLINE_ATTRIBUTES,
    });
  }, [text]);

  return <span dangerouslySetInnerHTML={{ __html: html }} />;
});

const tableCells = (line: string): string[] => {
  const value = line.trim().replace(/^\|/, '').replace(/\|$/, '');

  return value.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
};

const planDirectiveKind = (value: string | undefined): string => {
  const kind = value?.trim().toLowerCase();

  if (kind === 'info' || kind === 'tip' || kind === 'success'
    || kind === 'warning' || kind === 'danger' || kind === 'caution') {
    return kind;
  }

  return 'note';
};

/** A heading's classes by level; 3 and deeper share the last. */
const HEADING_CLASS = [
  'mb-4 mt-6 text-2xl font-bold tracking-tight first:mt-0',
  'mb-3 mt-8 text-xl font-semibold text-foreground/90',
  'mb-2 mt-6 text-base font-semibold text-foreground/80',
] as const;

/** A checkbox for a task item, its number in an ordered list, else a bullet. */
function listMarker(checked: boolean | undefined, listIndex: number | null | undefined): string {
  if (checked !== undefined) return checked ? '☑' : '☐';

  return listIndex === null || listIndex === undefined ? '•' : `${listIndex}.`;
}

const PlanBlock = React.memo(({
  block,
  headingId,
  listIndex,
}: {
  block: Block;
  headingId?: string;
  listIndex?: number | null;
}) => {
  if (block.type === 'heading') {
    const level = Math.min(6, Math.max(1, block.level ?? 1));

    const className = HEADING_CLASS[Math.min(level, 3) - 1];

    const content = <PlanInlineMarkdown text={block.content} />;

    if (level === 1) return <h1 id={headingId} data-block-id={block.id} className={className}>{content}</h1>;

    if (level === 2) return <h2 id={headingId} data-block-id={block.id} className={className}>{content}</h2>;

    if (level === 3) return <h3 id={headingId} data-block-id={block.id} className={className}>{content}</h3>;

    if (level === 4) return <h4 id={headingId} data-block-id={block.id} className={className}>{content}</h4>;

    if (level === 5) return <h5 id={headingId} data-block-id={block.id} className={className}>{content}</h5>;

    return <h6 id={headingId} data-block-id={block.id} className={className}>{content}</h6>;
  }

  if (block.type === 'blockquote') {
    const alert = block.alertKind;

    return (
      <blockquote data-block-id={block.id} className={`my-4 border-l-2 pl-4 text-muted-foreground ${alert ? `alert-${alert}` : 'border-primary/50 italic'}`}>
        {alert && <div className="alert-title mb-1 text-xs font-semibold uppercase tracking-wide">{alert}</div>}
        <PlanInlineMarkdown text={block.content} />
      </blockquote>
    );
  }

  if (block.type === 'list-item') {
    const marker = listMarker(block.checked, listIndex);

    return (
      <div data-block-id={block.id} className="my-1.5 flex items-start gap-3 text-sm leading-relaxed" style={{ marginLeft: `${(block.level ?? 0) * 1.25}rem` }}>
        <span className="select-none text-muted-foreground">{marker}</span>
        <span className={block.checked ? 'text-muted-foreground line-through' : 'text-foreground/90'}><PlanInlineMarkdown text={block.content} /></span>
      </div>
    );
  }

  if (block.type === 'math') {
    const html = katex.renderToString(block.content, {
      displayMode: true,
      throwOnError: false,
      trust: false,
    });

    return (
      <div
        data-block-id={block.id}
        data-math-tex={block.content}
        data-math-display="true"
        className="math-annotatable my-5 overflow-x-auto rounded-lg border border-border/30 bg-muted/30 p-4 text-center"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  if (block.type === 'code') {
    return (
      <pre data-block-id={block.id} className="my-5 overflow-x-auto rounded-lg border border-border/30 bg-muted/50 p-4 text-[13px]">
        <code className={`pn-code font-mono${block.language ? ` language-${block.language}` : ''}`}>{block.content}</code>
      </pre>
    );
  }

  if (block.type === 'directive') {
    const kind = planDirectiveKind(block.directiveKind);

    return (
      <aside data-block-id={block.id} className={`directive directive-${kind} my-4 rounded-lg border p-4`}>
        <div className="directive-title mb-1 text-xs font-semibold uppercase tracking-wide">{kind}</div>
        <p className="text-sm leading-relaxed text-foreground/90"><PlanInlineMarkdown text={block.content} /></p>
      </aside>
    );
  }

  if (block.type === 'table') {
    const rows = block.content.split('\n').filter((line) => line.trim());
    const header = rows[0] ? tableCells(rows[0]) : [];
    const body = rows.slice(2).map(tableCells);

    return (
      <div data-block-id={block.id} className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead><tr>{header.map((cell, index) => <th key={index} className="border border-border bg-muted/40 px-3 py-2 text-left font-medium"><PlanInlineMarkdown text={cell} /></th>)}</tr></thead>
          <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border border-border px-3 py-2"><PlanInlineMarkdown text={cell} /></td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }

  if (block.type === 'hr') return <hr data-block-id={block.id} className="my-8 border-border/30" />;

  return (
    <p data-block-id={block.id} className="mb-4 text-[15px] leading-relaxed text-foreground/90">
      <PlanInlineMarkdown text={block.content} />
    </p>
  );
});

const PlanListGroup = React.memo(({ blocks }: { blocks: Block[] }) => {
  const indices = computeListIndices(blocks);

  return (
    <div className="-mx-2 px-2 py-1">
      {blocks.map((block, index) => (
        <PlanBlock key={block.id} block={block} listIndex={indices[index]} />
      ))}
    </div>
  );
});

interface AnnotationToolbarProps {
  element: HTMLElement;
  selectionText: string;
  onDelete: () => void;
  onComment: () => void;
  onClose: () => void;
}

const PlanAnnotationToolbar = ({
  element,
  selectionText,
  onDelete,
  onComment,
  onClose,
}: AnnotationToolbarProps) => {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const update = () => {
      const rect = element.getBoundingClientRect();

      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        onClose();

        return;
      }

      setPosition({ top: rect.top - 44, left: rect.left + rect.width / 2 });
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);

    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [element, onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!position) return null;

  return createPortal(
    <div
      className="annotation-toolbar fixed z-[100] flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-2xl"
      style={position}
      onMouseDown={(event) => event.stopPropagation()}
      role="toolbar"
      aria-label="Annotate selection"
    >
      <button
        type="button"
        className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => settleLogged('plan_review.copy_failed', { doing: 'copying the selected text', otherwise: 'io' }, async () => {
          setCopied(await copyTextToClipboard(selectionText));
        })}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        onClick={onDelete}
      >
        Remove
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-xs text-annotation-comment hover:bg-muted"
        onClick={onComment}
      >
        Comment
      </button>
      <button
        type="button"
        className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onClose}
        aria-label="Cancel annotation"
      >
        Cancel
      </button>
    </div>,
    document.body,
  );
};

interface CommentPopoverProps {
  anchorEl: HTMLElement;
  contextText: string;
  initialText?: string;
  isGlobal: boolean;
  onSubmit: (text: string) => void;
  onClose: () => void;
}

const PlanCommentPopover = ({
  anchorEl,
  contextText,
  initialText = '',
  isGlobal,
  onSubmit,
  onClose,
}: CommentPopoverProps) => {
  const [text, setText] = useState(initialText);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const update = () => {
      const rect = anchorEl.getBoundingClientRect();
      const width = Math.min(384, window.innerWidth - 32);

      const left = Math.max(16, Math.min(
        rect.left + rect.width / 2 - width / 2,
        window.innerWidth - width - 16,
      ));

      const below = rect.bottom + 8;
      const top = below + 240 <= window.innerHeight ? below : Math.max(16, rect.top - 248);
      setPosition({ top, left, width });
    };

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);

    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorEl]);

  useEffect(() => {
    textareaRef.current?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (!(target instanceof Node)) return;

      if (text.trim() || rootRef.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);

    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose, text]);

  if (!position) return null;

  const submit = () => {
    const comment = text.trim();

    if (comment) onSubmit(comment);
  };

  return createPortal(
    <div
      ref={rootRef}
      data-comment-popover="true"
      className="fixed z-[100] overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
      style={position}
      role="dialog"
      aria-label={isGlobal ? 'Global plan comment' : 'Plan comment'}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
        <span className="truncate text-xs text-muted-foreground">
          {isGlobal ? 'Global comment' : contextText || 'Comment'}
        </span>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onClose}
          aria-label="Close comment"
        >
          ×
        </button>
      </div>
      <div className="p-3">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();

            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
          className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-ring"
          placeholder={isGlobal ? 'Add a global comment…' : 'Add a comment…'}
        />
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/50 px-3 py-2">
        <span className="mr-auto text-[10px] text-muted-foreground">Ctrl/⌘ + Enter</span>
        <button
          type="button"
          className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
          onClick={submit}
          disabled={!text.trim()}
        >
          Save
        </button>
      </div>
    </div>,
    document.body,
  );
};

/** Kinu's intentionally narrow Plannotator document surface. */
export const Viewer = forwardRef<ViewerHandle, ViewerProps>(({
  blocks,
  markdown,
  frontmatter,
  annotations,
  onAddAnnotation,
  onSelectAnnotation,
  selectedAnnotationId,
  mode,
  stickyActions = true,
  gridEnabled = false,
  maxWidth,
  copyLabel = 'Copy plan',
  readOnly = false,
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const globalCommentButtonRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [globalCommentOpen, setGlobalCommentOpen] = useState(false);
  const headingSlugMap = useMemo(() => buildHeadingSlugMap(blocks), [blocks]);

  const {
    toolbarState,
    commentPopover,
    handleAnnotate,
    handleToolbarClose,
    handleRequestComment,
    handleCommentSubmit,
    handleCommentClose,
    removeHighlight,
    clearAllHighlights,
    applyAnnotations,
  } = useAnnotationHighlighter({
    containerRef,
    annotations,
    onAddAnnotation,
    onSelectAnnotation,
    selectedAnnotationId,
    mode,
    enabled: true,
    interactive: !readOnly,
  });

  useImperativeHandle(ref, () => ({
    removeHighlight,
    clearAllHighlights,
    applySharedAnnotations: applyAnnotations,
  }), [applyAnnotations, clearAllHighlights, removeHighlight]);

  useEffect(() => {
    const eligible = annotations.filter((annotation) => (
      annotation.type !== AnnotationType.GLOBAL_COMMENT && Boolean(annotation.originalText)
    ));

    const timer = window.setTimeout(() => {
      clearAllHighlights();
      applyAnnotations(eligible);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [annotations, applyAnnotations, blocks, clearAllHighlights, readOnly]);

  const copyPlan = useCallback(async () => {
    if (!await copyTextToClipboard(markdown)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [markdown]);

  const addGlobalComment = useCallback((text: string) => {
    onAddAnnotation({
      id: annotationId(),
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.GLOBAL_COMMENT,
      text,
      originalText: '',
      createdA: Date.now(),
      author: 'Owner',
    });
    setGlobalCommentOpen(false);
  }, [onAddAnnotation]);

  return (
    <div className="relative z-50 w-full" style={maxWidth === null ? undefined : { maxWidth: maxWidth ?? 832 }}>
      <article
        ref={containerRef}
        data-print-region="article"
        className={`relative w-full rounded-xl bg-card py-5 md:py-8 lg:py-10 xl:py-12 ${
          gridEnabled ? 'border border-border/50 px-5 shadow-xl md:px-8 lg:px-10 xl:px-12' : ''
        }`}
      >
        <div
          data-print-hide
          className={`${stickyActions ? 'sticky top-3' : ''} z-30 float-right mt-6 flex items-start gap-1 rounded-lg bg-card/95 p-1 shadow-sm backdrop-blur-sm md:-mt-5 md:gap-2 md:p-2 lg:-mt-7 xl:-mt-9`}
        >
          {!readOnly && (
            <button
              ref={globalCommentButtonRef}
              type="button"
              className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setGlobalCommentOpen(true)}
            >
              Global comment
            </button>
          )}
          <button
            type="button"
            className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => void copyPlan()}
          >
            {copied ? 'Copied' : copyLabel}
          </button>
        </div>

        {frontmatter && <><div className="clear-right md:hidden" /><FrontmatterCard frontmatter={frontmatter} /></>}
        {!frontmatter && blocks.length > 0 && blocks[0]?.type !== 'heading' && <div className="mt-4" />}
        {groupBlocks(blocks).map((group) => group.type === 'list-group' ? (
          <PlanListGroup key={group.key} blocks={group.blocks} />
        ) : (
          <PlanBlock
            key={group.block.id}
            block={group.block}
            headingId={headingSlugMap.get(group.block.id)}
          />
        ))}

        {!readOnly && toolbarState && (
          <PlanAnnotationToolbar
            element={toolbarState.element}
            selectionText={toolbarState.selectionText}
            onDelete={() => handleAnnotate(AnnotationType.DELETION)}
            onComment={() => handleRequestComment()}
            onClose={handleToolbarClose}
          />
        )}
        {!readOnly && commentPopover && (
          <PlanCommentPopover
            anchorEl={commentPopover.anchorEl}
            contextText={commentPopover.contextText}
            initialText={commentPopover.initialText}
            isGlobal={false}
            onSubmit={(text) => handleCommentSubmit(text)}
            onClose={handleCommentClose}
          />
        )}
        {!readOnly && globalCommentOpen && globalCommentButtonRef.current && (
          <PlanCommentPopover
            anchorEl={globalCommentButtonRef.current}
            contextText=""
            isGlobal
            onSubmit={addGlobalComment}
            onClose={() => setGlobalCommentOpen(false)}
          />
        )}
      </article>
    </div>
  );
});
