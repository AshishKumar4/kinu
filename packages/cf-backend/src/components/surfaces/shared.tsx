/**
 * Shared presentational primitives used by both the chat column and the work
 * surfaces — kept in one place so there is a single source of truth (DRY) for
 * markdown rendering, code blocks, and empty states.
 */
import { memo, useState } from "react";
import { CaretRightIcon, CopyIcon } from "@phosphor-icons/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MAX_LINES_PER_FILE, type DiffLine } from "@proteus/core";
import { copyLabel, useCopy } from "@/hooks/use-copy";

/** Render a sequence of diff lines (add/del/ctx) red/green — shared by the
 *  scaffold-version diff (Self) and the workspace change-set (Output).
 *  `truncated` marks a bounded body, so a partial hunk never reads as the whole
 *  file. Two shapes reach here: a body clipped at {@link MAX_LINES_PER_FILE},
 *  and an EMPTY body for a file too long to align at all — they must not say
 *  the same thing, because "truncated at 1000 lines" over nothing reads as a
 *  rendering bug. */
export function DiffLines({ lines, truncated }: { lines: DiffLine[]; truncated?: boolean }) {
  return (
    <pre className="text-[11px] font-mono leading-relaxed overflow-x-auto max-h-[360px] overflow-y-auto m-0">
      {lines.map((l, i) => (
        <div key={i} className={l.kind === "add" ? "p-badge-success px-3" : l.kind === "del" ? "p-badge-danger px-3" : "p-text-3 px-3"}>
          <span className="select-none opacity-40 mr-2">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>{l.text || " "}
        </div>
      ))}
      {truncated && (
        <div className="p-text-3 px-3 italic">
          {lines.length === 0
            ? `File is over ${MAX_LINES_PER_FILE} lines — too long to diff line by line. The +/− totals above count every line.`
            : `… diff truncated at ${MAX_LINES_PER_FILE} lines. The +/− totals above cover the whole file.`}
        </div>
      )}
    </pre>
  );
}

/**
 * A fenced code block.
 *
 * Kumo's `<Code>` is its deprecated no-highlight component: it renders a
 * transparent, unpadded `w-auto` slab and nothing else, so every long line
 * escaped its container and was clipped by the wrapper's `overflow-hidden`.
 * Kumo's replacement (`CodeHighlighted`) hardcodes `github-light`/`vesper`
 * with no way to pass a theme, which would put GitHub's blues and purples on
 * a warm umber ground. So the block owns its own surface, in the same terms
 * the landing page sets its install command: one warm ink, a recessed
 * ground, a hairline, and a header welded to the body.
 *
 * `min-w-0` on the scroller is load-bearing — inside the flex column the
 * chat is built from, a track without it takes its content's width and
 * overflows the column instead of scrolling.
 */
export function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const { status, copy } = useCopy();
  const code = String(children).replace(/\n$/, "");
  const lang = className?.replace(/^language-/, "") ?? "";
  return (
    <div className="p-code my-2 rounded-lg overflow-hidden">
      <div className="p-code-head flex items-center justify-between gap-2 px-3 py-1 text-[10px]">
        <span className="truncate font-mono">{lang || "code"}</span>
        <button onClick={() => copy(code)} type="button"
          className={`flex shrink-0 cursor-pointer items-center gap-1 transition-colors ${status === "failed" ? "p-danger" : "hover:p-text"}`}>
          <CopyIcon size={12} />{copyLabel(status)}
        </button>
      </div>
      <pre className="p-scroll-x p-code-scroll m-0 px-3 py-2.5 text-[12.5px] leading-[1.55]"><code>{code}</code></pre>
    </div>
  );
}

// Memoized on the content string — the react-markdown re-parse is the
// dominant render cost, so unchanged messages must skip it entirely.
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{
      // A fence with no language gets no className, which is also what real
      // inline code gets — so ``` blocks used to come out as an inline pill
      // wrapping across lines. The block/inline question is answered by the
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
      a({ href, children }) { return <a href={href} target="_blank" rel="noopener noreferrer" className="p-accent hover:underline">{children}</a>; },
      table({ children }) { return <div className="p-scroll-x my-2 rounded-lg border p-border"><table className="w-full text-xs border-collapse">{children}</table></div>; },
      th({ children }) { return <th className="border-b p-border px-2.5 py-1.5 text-left font-medium p-fill whitespace-nowrap">{children}</th>; },
      td({ children }) { return <td className="border-b p-border px-2.5 py-1.5 align-top">{children}</td>; },
      // The fence's own <pre> is dropped: CodeBlock supplies one, and nesting
      // them would put a scroll container inside a scroll container.
      pre({ children }) { return <>{children}</>; },
    }}>{content}</Markdown>
  );
});

export function EmptyState({ icon, title, hint, children }: {
  icon: React.ReactNode; title: string; hint?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="p-text-3 mb-3 opacity-60">{icon}</div>
      <p className="text-sm p-text-2">{title}</p>
      {hint && <p className="text-xs p-text-3 mt-1.5 max-w-xs leading-relaxed">{hint}</p>}
      {children}
    </div>
  );
}

/** Default hints for empty surfaces. */
export const EMPTY_HINTS = {
  memory: "Ask your agent to remember something and it keeps it here.",
  tools: "Tools your agent learns appear here, extracted from successful conversations.",
  forks: "When the agent searches a tree of approaches, each search appears here, one branch per candidate, scored against the measure it declared.",
  preview: "When the agent exposes a Workspace or Sandbox port, the running app appears here as a live preview.",
};

/* ── small readouts shared by the fork tree's inspector and the evolution
      panels — one copy, so a metric tile means the same thing everywhere ── */

export function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border p-border p-recessed px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-normal p-text-3">{label}</div>
      <div className="text-[11px] p-text font-mono tabular-nums">{value}</div>
    </div>
  );
}

export function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-normal p-text-3">{title}</div>
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
  const key = `proteus.section.${id}`;
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
        <span className="text-sm font-medium p-text">{title}</span>
        {badge}
      </button>
      {open && <div className="mt-2.5">{children}</div>}
    </section>
  );
}

/**
 * How long ago, in the one wording the Work surface uses.
 *
 * There were two of these — the jobs card counted seconds, the changelog said
 * "just now" and fell back to a date — and they now render in the SAME feed,
 * where one row reading "8s ago" beside another reading "just now" is two
 * clocks, not one.
 */
export function timeAgo(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}
