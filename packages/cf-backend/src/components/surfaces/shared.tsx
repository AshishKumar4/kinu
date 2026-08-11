/**
 * Shared presentational primitives used by both the chat column and the work
 * surfaces — kept in one place so there is a single source of truth (DRY) for
 * markdown rendering, code blocks, and empty states.
 */
import { memo, useState } from "react";
import { Code } from "@cloudflare/kumo/components/code";
import { CaretRightIcon, CopyIcon } from "@phosphor-icons/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MAX_LINES_PER_FILE, type DiffLine } from "@/lib/diff";
import { copyLabel, useCopy } from "@/hooks/use-copy";

/** Render a sequence of diff lines (add/del/ctx) red/green — shared by the
 *  scaffold-version diff (Brain) and the workspace change-set (Output).
 *  `truncated` marks a body the parser bounded, so a partial hunk never reads
 *  as the whole file. */
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
          … diff truncated at {MAX_LINES_PER_FILE} lines — the +/− totals above cover the whole file.
        </div>
      )}
    </pre>
  );
}

export function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const { status, copy } = useCopy();
  const code = String(children).replace(/\n$/, "");
  const lang = className?.replace(/^language-/, "") ?? "";
  return (
    <div className="relative group my-2">
      <div className="flex items-center justify-between px-3 py-1 rounded-t-lg p-elevated border border-b-0 p-border text-[10px] p-text-3">
        <span>{lang || "code"}</span>
        <button onClick={() => copy(code)}
          className={`flex items-center gap-1 transition-colors ${status === "failed" ? "p-danger" : "hover:p-text"}`}>
          <CopyIcon size={12} />{copyLabel(status)}
        </button>
      </div>
      <div className="rounded-b-lg border border-t-0 p-border overflow-hidden">
        <Code code={code} lang={(lang || "text") as React.ComponentProps<typeof Code>["lang"]} />
      </div>
    </div>
  );
}

// Memoized on the content string — the react-markdown re-parse is the
// dominant render cost, so unchanged messages must skip it entirely.
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{
      code({ className, children, ...props }) {
        if (!className) return <code className="p-elevated px-1.5 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
        return <CodeBlock className={className}>{children}</CodeBlock>;
      },
      a({ href, children }) { return <a href={href} target="_blank" rel="noopener noreferrer" className="p-accent hover:underline">{children}</a>; },
      table({ children }) { return <div className="overflow-x-auto my-2"><table className="w-full text-xs border-collapse">{children}</table></div>; },
      th({ children }) { return <th className="border p-border px-2 py-1 text-left font-medium p-elevated">{children}</th>; },
      td({ children }) { return <td className="border p-border px-2 py-1">{children}</td>; },
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
export const EMPTY_HINTS: Record<string, string> = {
  memory: "Your agent will remember important information here. Ask it to remember something!",
  tools: "Tools your agent learns will appear here — extracted from successful conversations.",
  mcts: "Exploration trees appear when the agent uses think(strategy:'mcts') to investigate subproblems.",
  preview: "When the agent exposes a port (sandbox.exposePort), the running app appears here as a live preview.",
};

/**
 * A titled, collapsible section — the one header grammar the work surfaces
 * use, so the six that hand-rolled `<section><div flex gap-2>…` stay aligned.
 *
 * The Brain surface stacks identity, changelog, scaffold lineage, tools,
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
