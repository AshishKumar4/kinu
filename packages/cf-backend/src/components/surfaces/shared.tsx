import { createContext, memo, useContext, useCallback, useMemo, useState, type ReactNode } from "react";
import { CaretRightIcon, ImageBrokenIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Loader } from "@/components/ui/Loader";
import { useAsyncResource } from "@/hooks/use-async-resource";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { findPlaneReferences, isWholeReference, linkProse, MAX_LINES_PER_FILE, promoteSlateLinks, slateLinkId, type ChangelogEntry, type DiffLine, type MarkdownNode } from "@kinu.run/core";
import { blockServer, ephemeralSlateId, slateUiSegments, type EphemeralSlateAddress, type JsonValue, type SlateUiSegment } from "@kinu.run/core";
import { KinuMark } from "@/components/ui/KinuLogo";
import { InlineSlate } from "@/components/slates/InlineSlate";
import { DrawnSlate } from "@/components/slates/DrawnSlate";
import { SlateInlineContext } from "@/components/slates/context";
import { Pressable } from "@/components/ui/Pressable";
import { Button } from "@/components/ui/Button";
import { InlineAction } from "@/components/ui/InlineAction";
import { CopyText } from "@/components/ui/CopyButton";
import { Surface } from "@/components/ui/Surface";

const DIFF_LINE: Record<DiffLine["kind"], { tone: string; mark: string }> = {
  add: { tone: "p-badge-success px-3", mark: "+" },
  del: { tone: "p-badge-danger px-3", mark: "−" },
  ctx: { tone: "p-text-3 px-3", mark: " " },
  hunk: { tone: "p-text-3 px-3", mark: " " },
};

/** An empty truncated body (file too long to align) must read differently from one clipped at {@link MAX_LINES_PER_FILE}. */
export function DiffLines({ lines, truncated }: { lines: DiffLine[]; truncated?: boolean }) {
  return (
    <pre className="t-code overflow-x-auto max-h-90 overflow-y-auto m-0">
      {lines.map((l, i) => {
        const { tone, mark } = DIFF_LINE[l.kind];

        return (
          <div key={i} className={tone}>
            <span className="select-none opacity-40 mr-2">{mark}</span>{l.text || " "}
          </div>
        );
      })}
      {truncated && (
        <div className="p-text-3 px-3 italic">
          {lines.length === 0
            ? `File exceeds ${MAX_LINES_PER_FILE} lines. The totals include every line.`
            : `… diff ends at ${MAX_LINES_PER_FILE} lines. The totals cover the full file.`}
        </div>
      )}
    </pre>
  );
}


/** `wrap`: long lines wrap instead of scrolling, for data read rather than code copied (a tool's arguments). */
export function CodeBlock({ children, className, wrap = false }: { children: string; className?: string; wrap?: boolean }) {
  const code = children.replace(/\n$/, "");
  const lang = className?.replace(/^language-/, "") ?? "";

  const { resource, reload } = useAsyncResource(useCallback(async () => {
    if (!lang) return { code, language: lang, html: null };
    const { highlightCode } = await import("./code-highlighter");

    return highlightCode(code, lang);
  }, [code, lang]));

  const html = resource.status === "ready" && resource.value.code === code && resource.value.language === lang
    ? resource.value.html : null;

  return (
    <div className={`p-code p-code-block my-2${wrap ? " p-code-wrap" : ""}`}>
      <div className="t-meta t-mono p-code-head flex items-center justify-between gap-2 px-3 py-1">
        <span className="truncate font-mono">{lang || "code"}</span>
        <CopyText value={code} />
      </div>
      {html === null
        ? <pre className="t-code p-text p-scroll-x p-code-scroll m-0 px-3 py-2"><code>{code}</code></pre>
        : <div className="p-scroll-x p-code-scroll"><div className="p-code-highlight" dangerouslySetInnerHTML={{ __html: html }} /></div>}
      {resource.status === "error" && <Button variant="ghost" size="sm" onClick={reload} title={resource.message}>Syntax highlighting failed. Retry</Button>}
    </div>
  );
}

/** A failed image load throws nothing, so the error boundary never sees it; render a diagnostic with the raw link instead. */
function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <Surface look="outlined" as="span" className="t-meta my-2 inline-flex max-w-full items-baseline gap-2 px-2 py-1 p-text-3" data-markdown-image-error role="note">
        <ImageBrokenIcon size={13} aria-hidden className="self-center shrink-0" />
        <span className="min-w-0">
          {alt ? `Image failed to load: ${alt}` : "Image failed to load"}
          {src && (
            <>
              {" ("}
              <a href={src} target="_blank" rel="noopener noreferrer" className="p-accent-fg hover:underline break-all">{src}</a>
              {")"}
            </>
          )}
        </span>
      </Surface>
    );
  }

  return (
    <Surface look="clip" as="img" className="max-w-full" data-markdown-image src={src} alt={alt ?? ""} title={title} loading="lazy" onError={() => setFailed(true)} />
  );
}

/** The chat's file links: the planes it names (`vfs`, `computer`) and what opens one. Null elsewhere: a reference stays text. */
export const FileLinkContext = createContext<{ readonly roots: readonly string[]; readonly open: (reference: string) => void } | null>(null);

export function SlateLink({ id }: { id: string }) {
  const inline = useContext(SlateInlineContext);

  if (inline === null) return <code className="p-code-inline">{`slate://${id}`}</code>;

  // Spans only — this renderer runs inside the markdown <p>.
  return <span className="block my-2"><InlineSlate id={id} rpc={inline.rpc} display="inline" /></span>;
}

/**
 * A `<slate-ui>` block's page, drawn by the chat itself as its answer streams and opened as written once its block is
 * closed (`DrawnSlate`). What it calls through `kinu:slate` reaches its workspace once its answer is stored, which reads
 * the block back as the page's own; until then each call is refused in the page. Where no page can be drawn, its source,
 * folded.
 */
function SlateUiBlock({ address, html, closed, stored }: { address: EphemeralSlateAddress | null; html: string; closed: boolean; stored: boolean }) {
  const inline = useContext(SlateInlineContext);
  const rpc = inline?.rpc;
  const id = address === null ? null : ephemeralSlateId(address);
  const save = useMemo(() => (rpc === undefined || id === null || !stored ? undefined : async () => rpc("slate", [{ op: "save", page: id }])), [rpc, id, stored]);
  const call = useMemo(() => (rpc === undefined || !stored ? undefined : async (page: string, request: JsonValue) => rpc("drawnSlateCall", [page, request])), [rpc, stored]);

  if (inline === null || address === null || id === null) {
    return (
      <details className="my-2">
        <summary className="t-meta p-text-3 cursor-pointer">{address?.name ?? "slate-ui"}</summary>
        <CodeBlock className="language-html">{html}</CodeBlock>
      </details>
    );
  }

  return <DrawnSlate id={id} block={address.name} html={blockServer(html).page} closed={closed} call={call} save={save} />;
}

/** Which chat an answer is in: the workspace's own (null), or a hired agent's. */
export interface AnswerChat {
  readonly actorId: string | null;
}

interface AnswerPlace {
  readonly messageId: string;
  /** Whether the answer is stored, so its blocks can be read back. */
  readonly stored: boolean;
  /** The chat a block's id is resolved in; absent where none is, and a block shows its source. */
  readonly chat?: AnswerChat | undefined;
}

function AnswerSegment({ segment, place }: { segment: SlateUiSegment; place: AnswerPlace }) {
  const drawn = place.chat !== undefined;

  // A block never closed in a stored answer is the answer's text, as is any block where no chat draws pages.
  if (segment.kind === "text" || (segment.kind === "open" && (place.stored || !drawn))) return <MarkdownContent content={segment.text} />;

  const address = place.chat === undefined ? null : { actorId: place.chat.actorId, messageId: place.messageId, name: segment.name };

  return <SlateUiBlock address={address} html={segment.html} closed={segment.kind === "slate"} stored={place.stored} />;
}

/** An answer's text with its `<slate-ui>` blocks drawn in place. */
export function AnswerText({ text, place }: { text: string; place: AnswerPlace }) {
  const segments = useMemo(() => slateUiSegments(text), [text]);

  return <>{segments.map((segment, index) => <AnswerSegment key={index} segment={segment} place={place} />)}</>;
}

function remarkSlateLinks() {
  return (tree: MarkdownNode) => { promoteSlateLinks(tree); };
}

function remarkFileLinks({ roots }: { readonly roots: readonly string[] }) {
  const find = (value: string) => findPlaneReferences(value, roots).map(({ index, reference }) => ({ index, text: reference }));

  return (tree: MarkdownNode) => { linkProse(tree, find, (value) => isWholeReference(value, roots)); };
}

// Memoized on content: the react-markdown re-parse dominates render cost.
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const files = useContext(FileLinkContext);
  const roots = files?.roots ?? [];

  return (
    <Markdown
      remarkPlugins={files === null ? [remarkGfm, remarkSlateLinks] : [remarkGfm, remarkSlateLinks, [remarkFileLinks, { roots }]]}
      urlTransform={(url) => (url.startsWith('slate://') || isWholeReference(url, roots) ? url : defaultUrlTransform(url))}
      components={{
      // An unlabelled fence has no className, same as inline code, so a fence is detected by spanning lines.
      code({ node, className, children, ...props }) {
        const source = (node?.children ?? []).map((child) => (child.type === "text" ? child.value : "")).join("");

        if (!className && !source.includes("\n")) {
          return <code className="p-code-inline" {...props}>{children}</code>;
        }

        return <CodeBlock className={className}>{source}</CodeBlock>;
      },
      a({ href, children }) {
        const id = slateLinkId(href ?? '');

        if (id !== null) return <SlateLink id={id} />;

        if (files !== null && href !== undefined && isWholeReference(href, roots)) {
          return <InlineAction data-file-link={href} onClick={() => files.open(href)}>{children}</InlineAction>;
        }

        return <a href={href} target="_blank" rel="noopener noreferrer" className="p-accent-fg hover:underline">{children}</a>;
      },
      img({ src, alt, title }) { return <MarkdownImage key={src ?? ""} src={src} alt={alt} title={title} />; },
      table({ children }) { return <Surface look="outlined" className="p-scroll-x my-2"><table className="t-meta p-text-2 w-full border-collapse">{children}</table></Surface>; },
      th({ children }) { return <th className="p-table-head border-b p-border px-2 py-1 text-left whitespace-nowrap">{children}</th>; },
      td({ children }) { return <td className="border-b p-border px-2 py-1 align-top">{children}</td>; },
      // Drop the fence's own <pre>: CodeBlock supplies one, and nesting would nest scroll containers.
      pre({ children }) { return <>{children}</>; },
    }}>{content}</Markdown>
  );
});

export function EmptyState({ icon, title, hint, children }: {
  icon?: ReactNode; title: string; hint?: ReactNode; children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center" data-empty>
      <div className={`mb-3 ${icon ? "p-text-3 opacity-60" : "p-accent opacity-55"}`}>
        {icon ?? <KinuMark size={30} />}
      </div>
      <p className="t-label p-text-2">{title}</p>
      {hint && <p className="t-meta p-text-3 mt-2 max-w-xs">{hint}</p>}
      {children}
    </div>
  );
}

export function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Surface look="well" className="border p-border px-2 py-1">
      <div className="t-label">{label}</div>
      <div className="t-body t-mono p-text tabular-nums">{value}</div>
    </Surface>
  );
}

export function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="t-label">{title}</div>
      {children}
    </section>
  );
}

export function formatScore(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

/** `id` is the localStorage persistence key and must stay stable across renames of `title`. */
export function Section({ id, title, icon, badge, defaultOpen = true, children }: {
  id: string;
  title: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const key = `kinu.section.${id}`;

  // Read once on mount, write only on toggle: mirroring state would persist defaults as if chosen.
  const [open, setOpen] = useState(() => {
    const stored = localStorage.getItem(key);

    return stored === null ? defaultOpen : stored === "1";
  });

  const toggle = () => {
    setOpen((prev) => {
      localStorage.setItem(key, prev ? "0" : "1");

      return !prev;
    });
  };

  return (
    <section data-section={id}>
      <Pressable className="group/section flex items-center gap-2 py-1" onClick={toggle} aria-expanded={open}>
        <CaretRightIcon
          size={12}
          className={`shrink-0 p-text-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        {icon}
        <span className="t-label" data-section-title>{title}</span>
        {badge && <span className="ml-auto inline-flex shrink-0" data-section-badge>{badge}</span>}
      </Pressable>
      {open && <div className="mt-3">{children}</div>}
    </section>
  );
}


interface HistoryBoundaryProps {
  loading: boolean;
  error: string | null;
  exhausted: boolean;
  onRetry: () => void;
}

function HistoryBoundaryNotice({ loading, error, exhausted, onRetry }: HistoryBoundaryProps) {
  if (error !== null) {
    return (
      <>
        <WarningCircleIcon size={13} className="p-danger shrink-0" />
        <span className="p-text-3">Could not load earlier messages.</span>
        <Button variant="ghost" size="sm" onClick={() => { onRetry(); }}>Retry</Button>
      </>
    );
  }

  if (loading) {
    return <span className="flex items-center gap-2 p-text-3"><Loader size="sm" />Loading earlier messages…</span>;
  }

  if (exhausted) {
    return (
      <>
        <span className="h-px flex-1 p-border border-t" />
        <span className="t-meta p-text-3">Beginning of the conversation</span>
        <span className="h-px flex-1 p-border border-t" />
      </>
    );
  }

  return null;
}

/** All four states share one height: this row sits above the prepend, so a size change shifts the transcript. */
export function HistoryBoundary(props: HistoryBoundaryProps) {
  return (
    <div data-scroll-edge="" className="t-meta flex h-7 items-center justify-center gap-2">
      <HistoryBoundaryNotice {...props} />
    </div>
  );
}

/** Only a delivered `status: "end"` page permits an empty claim. */
export function ConversationStartBoundary({
  hasEntries, streaming, error, exhausted, onRetry, pending, empty,
}: {
  hasEntries: boolean;
  streaming: boolean;
  error: string | null;
  exhausted: boolean;
  onRetry: () => void;
  pending: ReactNode;
  empty: ReactNode;
}) {
  if (hasEntries) return null;

  if (error !== null) {
    return <HistoryBoundary loading={false} error={error} exhausted={false} onRetry={onRetry} />;
  }

  return exhausted && !streaming ? empty : pending;
}

export function changelogFactKey(entry: ChangelogEntry): string | null {
  if (entry.kind !== 'fact' || !entry.id.startsWith('fact:')) return null;
  const key = entry.id.slice('fact:'.length);

  return key === '' ? null : key;
}

