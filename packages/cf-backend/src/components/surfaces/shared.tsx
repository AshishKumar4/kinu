/**
 * Shared presentational primitives used by both the chat column and the work
 * surfaces — kept in one place so there is a single source of truth (DRY) for
 * markdown rendering, code blocks, and empty states.
 */
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

/** Render a sequence of diff lines (add/del/ctx) red/green — shared by the
 *  scaffold-version diff (Self) and the workspace change-set (Output).
 *  `truncated` marks a bounded body, so a partial hunk never reads as the whole
 *  file. Two shapes reach here: a body clipped at {@link MAX_LINES_PER_FILE},
 *  and an EMPTY body for a file too long to align at all — they must not say
 *  the same thing, because "truncated at 1000 lines" over nothing reads as a
 *  rendering bug. */
export function DiffLines({ lines, truncated }: { lines: DiffLine[]; truncated?: boolean }) {
  return (
    <pre className="p-t-code overflow-x-auto max-h-[360px] overflow-y-auto m-0">
      {lines.map((l, i) => (
        <div key={i} className={l.kind === "add" ? "p-badge-success px-3" : l.kind === "del" ? "p-badge-danger px-3" : "p-text-3 px-3"}>
          <span className="select-none opacity-40 mr-2">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>{l.text || " "}
        </div>
      ))}
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


/** One code well for fences, tool inputs and source viewers. Unknown grammars
 * stay readable as plain text. One cached highlighter loads grammars on demand. */
export function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const { status, copy } = useCopy();
  const code = String(children).replace(/\n$/, "");
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

/**
 * A Markdown image, with failure told rather than shown as a broken glyph.
 *
 * A resource that fails to load throws nothing, so the chat's error boundary
 * never hears about it — the reader got a browser-drawn broken-image mark with
 * no name and no way to the source. On failure (or an image with no source at
 * all) this renders a quiet diagnostic instead: what failed, named by the
 * author's alt text when there is one, and the raw link — a browser tab says
 * WHY it failed (403, 404, mixed content) better than an img box ever can.
 */
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
              {" — "}
              <a href={src} target="_blank" rel="noopener noreferrer" className="p-accent hover:underline break-all">{src}</a>
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

/** One `slate://<id>` link in markdown. Inside the chat column (the context
 *  the workspace page installs) it mounts the live card; anywhere else the
 *  address is the whole story, so it renders as the code it would read as. */
function SlateLink({ id }: { id: string }) {
  const inline = useContext(SlateInlineContext);

  if (inline === null) return <code className="p-code-inline">{`slate://${id}`}</code>;

  // Spans only — this renderer runs inside the markdown <p>.
  return <span className="block my-2"><InlineSlate id={id} rpc={inline.rpc} display="inline" /></span>;
}

/** remark pass: a bare `slate://<id>` written as TEXT becomes a link node, so
 *  the `a` renderer — and nothing else — decides how it renders. Walks the
 *  mdast directly; a link or code node is left alone, and only ids that pass
 *  `slateLinkId` count. */
function remarkSlateLinks() {
  // The slice of mdast this pass reads and writes, declared locally: pulling
  // `mdast` types in for one plugin is heavier than the plugin itself. A link
  // node carries its address in `url`; a text node in `value`.
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
      const child = children[i]!;

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

// Memoized on the content string — the react-markdown re-parse is the
// dominant render cost, so unchanged messages must skip it entirely.
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm, remarkSlateLinks]} urlTransform={(url) => url.startsWith('slate://') ? url : defaultUrlTransform(url)} components={{
      // A fence with no language gets no className, which is also what real
      // inline code gets — so className alone renders a ``` block as an inline
      // pill wrapping across lines. The block/inline question is answered by the
      // node's position (react-markdown puts a fence inside a <pre>), which
      // `pre` below unwraps, so the check here is on the content itself: a
      // fence is the thing that spans lines.
      code({ className, children, ...props }) {
        const text = String(children ?? "");

        if (!className && !text.includes("\n")) {
          return <code className="p-code-inline" {...props}>{children}</code>;
        }

        return <CodeBlock className={className}>{children}</CodeBlock>;
      },
      a({ href, children }) {
        const id = slateLinkId(href ?? '');

        if (id !== null) return <SlateLink id={id} />;

        return <a href={href} target="_blank" rel="noopener noreferrer" className="p-accent hover:underline">{children}</a>;
      },
      // Keyed on the source so a re-render that swaps the image also resets
      // the failure state — the new source deserves its own attempt.
      img({ src, alt, title }) { return <MarkdownImage key={src ?? ""} src={src} alt={alt} title={title} />; },
      table({ children }) { return <div className="p-scroll-x my-2 rounded-lg border p-border"><table className="w-full text-xs border-collapse">{children}</table></div>; },
      th({ children }) { return <th className="border-b p-border px-2.5 py-1.5 text-left font-medium p-fill whitespace-nowrap">{children}</th>; },
      td({ children }) { return <td className="border-b p-border px-2.5 py-1.5 align-top">{children}</td>; },
      // The fence's own <pre> is dropped: CodeBlock supplies one, and nesting
      // them would put a scroll container inside a scroll container.
      pre({ children }) { return <>{children}</>; },
    }}>{content}</Markdown>
  );
});

/** The register an absence is announced in: the mark where no icon carries a
 *  more specific meaning, and the title as a mono annotation — the banner's
 *  own caption grammar, instead of the bare grey icon-and-sentence this was. */
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

/* ── small readouts shared by the fork tree's inspector and the evolution
      panels — one copy, so a metric tile means the same thing everywhere ── */

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

/** The product's danger→warning→success bands, as a text token. */
export function scoreColor(value: number): string {
  if (value >= 0.7) return "p-success";

  if (value >= 0.4) return "p-warning";

  return "p-danger";
}

export function formatScore(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

/**
 * A titled, collapsible section — the one header grammar the work surfaces
 * use, so the six that hand-rolled `<section><div flex gap-2>…` stay aligned.
 *
 * The Self surface stacks identity, changelog, scaffold lineage, tools,
 * memory and the world model into one scroll; being able to fold the ones you
 * are not reading is what makes it usable at length. Which sections a person
 * keeps folded is a property of that person's workspace, not of the agent, so
 * it lives in localStorage beside the theme choice rather than in agent state.
 *
 * `id` is that persistence key and must be stable across renames of `title`.
 */
export function Section({ id, title, icon, badge, defaultOpen = true, children }: {
  id: string;
  title: string;
  icon: React.ReactNode;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const key = `kinu.section.${id}`;

  // Read once on mount and write only on toggle: an effect that mirrored state
  // would stamp every default into storage on first paint, which then looks
  // like a choice the user made and freezes the defaults forever.
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


/**
 * The top of the transcript: what is above the oldest message on screen.
 *
 * Four distinct answers, never collapsed into silence. "Failed" in particular
 * has to be its own state — rendering nothing there would tell the reader they
 * had reached the beginning of a conversation the pane simply could not fetch.
 *
 * All four are the same height, including the idle one. This row sits directly
 * above the prepend, so a row that changes size as it changes state moves the
 * transcript under the reader by the difference — measured at 15px per page
 * before it was pinned, which is small, constant, and accumulates once per
 * page for as long as someone keeps scrolling.
 */
export function HistoryBoundary({ loading, error, exhausted, onRetry }: {
  loading: boolean;
  error: string | null;
  exhausted: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-7 items-center justify-center gap-2 text-xs">
      {error ? (
        <>
          <WarningCircleIcon size={13} className="p-danger shrink-0" />
          <span className="p-text-3">Could not load earlier messages.</span>
          <button onClick={onRetry} className="p-accent hover:underline">Retry</button>
        </>
      ) : loading ? (
        <span className="flex items-center gap-2 p-text-3"><Loader size="sm" />Loading earlier messages…</span>
      ) : exhausted ? (
        <>
          <span className="h-px flex-1 p-border border-t" />
          <span className="p-text-3 p-meta">Beginning of the conversation</span>
          <span className="h-px flex-1 p-border border-t" />
        </>
      ) : null}
    </div>
  );
}

/**
 * The authority gate before a thread has any renderable entries.
 *
 * A delivered `status: "end"` page is the only fact that permits an empty
 * claim. A failed first page keeps its Retry, and every unresolved state keeps
 * the loading surface. Both chat columns and the gallery use this component so
 * the product state and its browser proof cannot drift apart.
 */
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

/** A crafted tool's live row, as `getToolDescriptions` reports it. */
export interface CraftedToolDetail {
  name: string;
  description: string;
  qualityScore: number;
  usageCount: number;
}

/** A digest entry with its tool row joined in. Absent on facts, on unknown
 *  tools, and when the list failed to load — the card then shows what the
 *  entry row itself holds, never a guess. */
export interface ChangelogEntryView extends ChangelogEntry {
  toolDetail?: CraftedToolDetail;
}

/** A tool entry's name, from its `tool:<name>:<at>` id. */
export function changelogToolName(entry: ChangelogEntry): string | null {
  if (entry.kind !== 'tool') return null;
  const rest = entry.id.startsWith('tool:') ? entry.id.slice('tool:'.length) : entry.id;
  const at = rest.lastIndexOf(':');
  const name = (at < 0 ? rest : rest.slice(0, at)).trim();

  return name === '' ? null : name;
}

/** A fact entry's key, from its `fact:<key>` id. */
export function changelogFactKey(entry: ChangelogEntry): string | null {
  if (entry.kind !== 'fact' || !entry.id.startsWith('fact:')) return null;
  const key = entry.id.slice('fact:'.length);

  return key === '' ? null : key;
}

/** Join tool entries to the live tool list by name. Facts pass through:
 *  their row already carries everything the card shows. */
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
