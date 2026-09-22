import { memo, useContext, useCallback, useState, type ReactNode } from "react";
import { CaretRightIcon, CopyIcon, ImageBrokenIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import { useAsyncResource } from "@/hooks/use-async-resource";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyLabel, useCopy } from "@/hooks/use-copy";
import { MAX_LINES_PER_FILE, slateLinkId, type ChangelogEntry, type DiffLine } from "@kinu.run/core";
import { KinuMark } from "@/components/ui/KinuLogo";
import { InlineSlate } from "@/components/slates/InlineSlate";
import { SlateInlineContext } from "@/components/slates/context";

const DIFF_LINE: Record<DiffLine["kind"], { tone: string; mark: string }> = {
  add: { tone: "p-badge-success px-3", mark: "+" },
  del: { tone: "p-badge-danger px-3", mark: "−" },
  ctx: { tone: "p-text-3 px-3", mark: " " },
};

/** An empty truncated body (file too long to align) must read differently from one clipped at {@link MAX_LINES_PER_FILE}. */
export function DiffLines({ lines, truncated }: { lines: DiffLine[]; truncated?: boolean }) {
  return (
    <pre className="p-t-code overflow-x-auto max-h-[360px] overflow-y-auto m-0">
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


export function CodeBlock({ children, className }: { children: string; className?: string }) {
  const { status, copy } = useCopy();
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
    <div className="p-code my-2 rounded-lg overflow-hidden">
      <div className="p-code-head flex items-center justify-between gap-2 px-3 py-1 p-annotation">
        <span className="truncate font-mono">{lang || "code"}</span>
        <button onClick={() => copy(code)} type="button"
          className={`flex shrink-0 cursor-pointer items-center gap-1 transition-colors ${status === "failed" ? "p-danger" : "hover:p-text"}`}>
          <CopyIcon size={12} />{copyLabel(status)}
        </button>
      </div>
      {html === null
        ? <pre className="p-scroll-x p-code-scroll m-0 px-3 py-2.5 p-t-code"><code>{code}</code></pre>
        : <div className="p-scroll-x p-code-scroll"><div className="p-code-highlight" dangerouslySetInnerHTML={{ __html: html }} /></div>}
      {resource.status === "error" && <button type="button" onClick={reload} className="px-3 py-1 text-xs p-warning" title={resource.message}>Syntax highlighting failed. Retry</button>}
    </div>
  );
}

/** A failed image load throws nothing, so the error boundary never sees it; render a diagnostic with the raw link instead. */
function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <span data-markdown-image-error role="note" className="my-1.5 inline-flex max-w-full items-baseline gap-1.5 rounded-lg border p-border px-2.5 py-1.5 text-xs p-text-3">
        <ImageBrokenIcon size={13} aria-hidden className="self-center shrink-0" />
        <span className="min-w-0">
          {alt ? `Image failed to load: ${alt}` : "Image failed to load"}
          {src && (
            <>
              {" ("}
              <a href={src} target="_blank" rel="noopener noreferrer" className="p-accent hover:underline break-all">{src}</a>
              {")"}
            </>
          )}
        </span>
      </span>
    );
  }

  return (
    <img data-markdown-image src={src} alt={alt ?? ""} title={title} loading="lazy"
      className="max-w-full rounded-lg" onError={() => setFailed(true)} />
  );
}

function SlateLink({ id }: { id: string }) {
  const inline = useContext(SlateInlineContext);

  if (inline === null) return <code className="p-code-inline">{`slate://${id}`}</code>;

  // Spans only — this renderer runs inside the markdown <p>.
  return <span className="block my-2"><InlineSlate id={id} rpc={inline.rpc} display="inline" /></span>;
}

function remarkSlateLinks() {
  // Local mdast slice: importing `mdast` types for one plugin is heavier than the plugin.
  interface MdNode {
    readonly type: string;
    readonly value?: string;
    readonly url?: string;
    children?: MdNode[];
  }

  const RE = /slate:\/\/[^\s)\]>"'`]+/g;

  const split = (node: MdNode): MdNode[] | null => {
    const parts: MdNode[] = [];
    let rest = node.value ?? '';

    while (true) {
      RE.lastIndex = 0;
      const hit = RE.exec(rest);

      if (hit === null) break;

      const id = slateLinkId(hit[0]);

      if (id === null) continue;

      const before = rest.slice(0, hit.index);

      if (before !== '') parts.push({ type: 'text', value: before });

      parts.push({ type: 'link', url: hit[0], children: [{ type: 'text', value: hit[0] }] });
      rest = rest.slice(hit.index + hit[0].length);
    }

    if (parts.length === 0) return null;

    if (rest !== '') parts.push({ type: 'text', value: rest });

    return parts;
  };

  const walk = (node: MdNode): void => {
    if (node.type === 'link' || node.type === 'linkReference' || node.type === 'inlineCode' || node.type === 'code') return;

    const children = node.children;

    if (children === undefined) return;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      if (child.type === 'text') {
        const parts = split(child);

        if (parts !== null) {
          children.splice(i, 1, ...parts);
          i += parts.length - 1;

          continue;
        }
      }

      walk(child);
    }
  };

  return (tree: MdNode) => { walk(tree); };
}

// Memoized on content: the react-markdown re-parse dominates render cost.
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm, remarkSlateLinks]} urlTransform={(url) => url.startsWith('slate://') ? url : defaultUrlTransform(url)} components={{
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

        return <a href={href} target="_blank" rel="noopener noreferrer" className="p-accent hover:underline">{children}</a>;
      },
      img({ src, alt, title }) { return <MarkdownImage key={src ?? ""} src={src} alt={alt} title={title} />; },
      table({ children }) { return <div className="p-scroll-x my-2 rounded-lg border p-border"><table className="w-full text-xs border-collapse">{children}</table></div>; },
      th({ children }) { return <th className="border-b p-border px-2.5 py-1.5 text-left font-medium p-fill whitespace-nowrap">{children}</th>; },
      td({ children }) { return <td className="border-b p-border px-2.5 py-1.5 align-top">{children}</td>; },
      // Drop the fence's own <pre>: CodeBlock supplies one, and nesting would nest scroll containers.
      pre({ children }) { return <>{children}</>; },
    }}>{content}</Markdown>
  );
});

export function EmptyState({ icon, title, hint, children }: {
  icon?: ReactNode; title: string; hint?: ReactNode; children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className={`mb-3 ${icon ? "p-text-3 opacity-60" : "text-[var(--c-accent)] opacity-55"}`}>
        {icon ?? <KinuMark size={30} />}
      </div>
      <p className="p-eyebrow p-text-2">{title}</p>
      {hint && <p className="text-xs p-text-3 mt-2 max-w-xs leading-relaxed">{hint}</p>}
      {children}
    </div>
  );
}

export function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border p-border p-recessed px-2 py-1.5">
      <div className="p-eyebrow">{label}</div>
      <div className="p-row-text p-text font-mono tabular-nums">{value}</div>
    </div>
  );
}

export function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="p-eyebrow">{title}</div>
      {children}
    </section>
  );
}

export function scoreColor(value: number): string {
  if (value >= 0.7) return "p-success";

  if (value >= 0.4) return "p-warning";

  return "p-danger";
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
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="group/section flex w-full items-center gap-2 rounded-md py-1 text-left cursor-pointer p-row-hover transition-colors"
      >
        <CaretRightIcon
          size={12}
          className={`shrink-0 p-text-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        {icon}
        <span className="p-label">{title}</span>
        {badge && <span className="ml-auto inline-flex shrink-0">{badge}</span>}
      </button>
      {open && <div className="mt-2.5">{children}</div>}
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
        <button onClick={onRetry} className="p-accent hover:underline">Retry</button>
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
        <span className="p-text-3 p-meta">Beginning of the conversation</span>
        <span className="h-px flex-1 p-border border-t" />
      </>
    );
  }

  return null;
}

/** All four states share one height: this row sits above the prepend, so a size change shifts the transcript. */
export function HistoryBoundary(props: HistoryBoundaryProps) {
  return (
    <div className="flex h-7 items-center justify-center gap-2 text-xs">
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

export interface CraftedToolDetail {
  name: string;
  description: string;
  qualityScore: number;
  usageCount: number;
}

export interface ChangelogEntryView extends ChangelogEntry {
  toolDetail?: CraftedToolDetail;
}

export function changelogToolName(entry: ChangelogEntry): string | null {
  if (entry.kind !== 'tool') return null;
  const rest = entry.id.startsWith('tool:') ? entry.id.slice('tool:'.length) : entry.id;
  const at = rest.lastIndexOf(':');
  const name = (at < 0 ? rest : rest.slice(0, at)).trim();

  return name === '' ? null : name;
}

export function changelogFactKey(entry: ChangelogEntry): string | null {
  if (entry.kind !== 'fact' || !entry.id.startsWith('fact:')) return null;
  const key = entry.id.slice('fact:'.length);

  return key === '' ? null : key;
}

export function withToolDetails(
  entries: readonly ChangelogEntry[],
  tools: readonly CraftedToolDetail[],
): ChangelogEntryView[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return entries.map((entry) => {
    const name = changelogToolName(entry);
    const detail = name !== null ? byName.get(name) : undefined;

    return detail === undefined ? { ...entry } : { ...entry, toolDetail: detail };
  });
}
