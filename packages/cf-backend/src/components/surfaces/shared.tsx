/**
 * Shared presentational primitives used by both the chat column and the work
 * surfaces — kept in one place so there is a single source of truth (DRY) for
 * markdown rendering, code blocks, preview-URL detection, and empty states.
 */
import { useState } from "react";
import { Code } from "@cloudflare/kumo/components/code";
import { CopyIcon } from "@phosphor-icons/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DiffLine } from "@/lib/diff";

/** Render a sequence of diff lines (add/del/ctx) red/green — shared by the
 *  scaffold-version diff (Brain) and the workspace change-set (Output). */
export function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="text-[11px] font-mono leading-relaxed overflow-x-auto max-h-[360px] overflow-y-auto m-0">
      {lines.map((l, i) => (
        <div key={i} className={l.kind === "add" ? "bg-emerald-500/10 text-emerald-300 px-3" : l.kind === "del" ? "bg-red-500/10 text-red-300 px-3" : "p-text-3 px-3"}>
          <span className="select-none opacity-40 mr-2">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>{l.text || " "}
        </div>
      ))}
    </pre>
  );
}

export function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, "");
  const lang = className?.replace(/^language-/, "") ?? "";
  return (
    <div className="relative group my-2">
      <div className="flex items-center justify-between px-3 py-1 rounded-t-lg p-elevated border border-b-0 p-border text-[10px] p-text-3">
        <span>{lang || "code"}</span>
        <button onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="flex items-center gap-1 hover:p-text transition-colors">
          <CopyIcon size={12} />{copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <div className="rounded-b-lg border border-t-0 p-border overflow-hidden">
        <Code code={code} lang={(lang || "text") as React.ComponentProps<typeof Code>["lang"]} />
      </div>
    </div>
  );
}

export function MarkdownContent({ content }: { content: string }) {
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
}

/**
 * Detect a Proteus path-style preview URL anywhere inside a tool result. Tool
 * outputs are usually strings (e.g. `https://.../_preview/8080/.../`) but can
 * also be objects with a `url` field (exposeSandboxPort returns `{url}`).
 */
export function extractPreviewUrl(output: unknown): string | null {
  const re = /https:\/\/[^\s"']+\/_preview\/\d+\/[^/\s"']+\/[a-z0-9_]+\/?[^\s"']*/i;
  if (typeof output === "string") {
    const m = output.match(re);
    return m ? m[0] : null;
  }
  if (output && typeof output === "object") {
    const url = (output as { url?: unknown }).url;
    if (typeof url === "string") {
      const m = url.match(re);
      return m ? m[0] : null;
    }
    try {
      const m = JSON.stringify(output).match(re);
      return m ? m[0] : null;
    } catch { return null; }
  }
  return null;
}

export function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="p-text-3 mb-3 opacity-60">{icon}</div>
      <p className="text-sm p-text-2">{title}</p>
      {hint && <p className="text-xs p-text-3 mt-1.5 max-w-xs leading-relaxed">{hint}</p>}
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
