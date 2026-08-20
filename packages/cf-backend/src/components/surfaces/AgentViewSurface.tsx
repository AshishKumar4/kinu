/**
 * Agent View — a dashboard Kinu wrote, drawn entirely by this file.
 *
 * The agent supplies a JSON spec (validated in core, twice: when it publishes
 * and again when the orchestrator reads the live file). Everything below turns
 * that data into components this app already ships. Nothing here evaluates
 * agent text as code or markup: values become React children, prose goes
 * through the app's one `MarkdownContent` pipeline, and the spec has no field
 * anywhere that carries a URL.
 *
 * Two rules this component exists to hold:
 *
 *  1. The vocabulary is the containment. If a block type is not in the switch
 *     below, it cannot render — and it cannot reach the switch, because the
 *     core schema rejected it at write time.
 *  2. A view is visibly the agent's. The provenance strip is not decoration:
 *     the owner must never have to guess whether a panel is ours or Kinu's,
 *     because the approval, consent and audit surfaces that ARE ours are the
 *     ones worth impersonating.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwiseIcon, CodeIcon, SparkleIcon, WarningIcon } from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo/components/loader";
import {
  JsonArraySchema, JsonValueSchema, ViewSpecSchema, resolveViewPath,
  type JsonValue,
  type ViewBlock, type ViewColumn, type ViewLeafBlock, type ViewSource, type ViewSpec,
} from "@kinu/core";
import type { Rpc } from "@/lib/protocol";
import { EmptyState, MarkdownContent, Section } from "./shared";
import * as v from 'valibot';
import { renderThrownChain } from "@kinu/core/obs";

type SourceState = { data: JsonValue } | { error: string };
const AgentViewResponseSchema = v.object({
  ok: v.boolean(),
  spec: v.optional(ViewSpecSchema),
  version: v.optional(v.number()),
  error: v.optional(v.string()),
});

/** One fetch per distinct (rpc, limit) pair, however many blocks read it. */
const sourceKey = (source: ViewSource): string => `${source.rpc}:${source.limit ?? ""}`;

function collectSources(spec: ViewSpec): ViewSource[] {
  const seen = new Map<string, ViewSource>();
  const add = (block: ViewLeafBlock) => {
    if (block.type === "markdown") return;
    const key = sourceKey(block.source);
    if (!seen.has(key)) seen.set(key, block.source);
  };
  for (const block of spec.blocks) {
    if (block.type === "section") block.blocks.forEach(add);
    else add(block);
  }
  return [...seen.values()];
}

// ── cells ───────────────────────────────────────────────────────────────────

/** Tone by value, over the status words the workspace actually uses. Unknown
 *  values stay neutral rather than guessing — a badge that colours a word it
 *  does not understand is worse than a plain one. */
const BADGE_TONE = new Map([
  ["deployed", "p-badge-success"], ["passed", "p-badge-success"], ["ok", "p-badge-success"],
  ["completed", "p-badge-success"], ["success", "p-badge-success"], ["running", "p-badge-info"],
  ["applying", "p-badge-info"], ["validating", "p-badge-info"], ["queued", "p-badge-neutral"],
  ["planning", "p-badge-neutral"], ["patching", "p-badge-neutral"], ["pending", "p-badge-warning"],
  ["awaiting_approval", "p-badge-warning"], ["preview_ready", "p-badge-warning"],
  ["failed", "p-badge-danger"], ["rejected", "p-badge-danger"], ["rolled_back", "p-badge-danger"],
  ["error", "p-badge-danger"],
]);

function scalarText(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "—";
  if (v.is(v.string(), value)) return value;
  if (v.is(v.number(), value) || v.is(v.boolean(), value)) return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  return "—";
}

function timeText(value: JsonValue | undefined): string {
  const ms = v.is(v.number(), value) ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function Cell({ value, as }: { value: JsonValue | undefined; as: ViewColumn["as"] }) {
  if (as === "badge") {
    const text = scalarText(value);
    return (
      <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        BADGE_TONE.get(text.toLowerCase()) ?? "p-badge-neutral"
      }`}>{text.replace(/_/g, " ")}</span>
    );
  }
  if (as === "time") return <span className="p-num p-text-2">{timeText(value)}</span>;
  if (as === "number") {
    return <span className="p-num">{v.is(v.number(), value) ? value.toLocaleString() : scalarText(value)}</span>;
  }
  return <span>{scalarText(value)}</span>;
}

// ── the blocks ──────────────────────────────────────────────────────────────

function asRows(value: JsonValue | undefined): JsonValue[] {
  return v.is(JsonArraySchema, value) ? value : [];
}

function BlockNotice({ text }: { text: string }) {
  return (
    <div className="p-notice-warning rounded-lg px-3 py-2 text-xs flex items-start gap-2">
      <WarningIcon size={13} className="mt-0.5 shrink-0" /><span>{text}</span>
    </div>
  );
}

function BlockTitle({ children }: { children: string }) {
  return <div className="p-eyebrow p-text-3 mb-1.5">{children}</div>;
}

function LeafBlock({ block, sources }: { block: ViewLeafBlock; sources: Map<string, SourceState> }) {
  // MarkdownContent inherits its scale from the container, and its default is
  // chat prose — a size that shouts inside a dashboard of 11-13px rows.
  if (block.type === "markdown") {
    return <div className="text-xs p-text-2 leading-relaxed"><MarkdownContent content={block.text} /></div>;
  }

  const state = sources.get(sourceKey(block.source));
  if (!state) return <BlockNotice text={`No data loaded for ${block.source.rpc}.`} />;
  if ("error" in state) return <BlockNotice text={`${block.source.rpc} — ${state.error}`} />;
  const value = resolveViewPath(state.data, block.source.path);

  switch (block.type) {
    case "stat": {
      const shown = block.agg === "count" ? asRows(value).length : value;
      return (
        <div className="p-card px-3.5 py-3">
          <div className="p-num text-2xl p-text leading-tight">
            {block.agg === "count" ? asRows(value).length.toLocaleString() : scalarText(shown)}
            {block.suffix && <span className="text-sm p-text-3 ml-1">{block.suffix}</span>}
          </div>
          <div className="p-eyebrow p-text-3 mt-1">{block.label}</div>
        </div>
      );
    }

    case "table": {
      const rows = asRows(value);
      if (rows.length === 0) return <BlockNotice text={`${block.source.rpc} returned nothing to tabulate.`} />;
      return (
        <div>
          {block.title && <BlockTitle>{block.title}</BlockTitle>}
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr>{block.columns.map((c) => (
                  <th key={c.field} className="border p-border px-2 py-1 text-left font-medium p-fill">{c.label}</th>
                ))}</tr>
              </thead>
              <tbody>
                {rows.slice(0, block.source.limit ?? rows.length).map((row, i) => (
                  <tr key={i}>{block.columns.map((c) => (
                    <td key={c.field} className="border p-border px-2 py-1">
                      <Cell value={resolveViewPath(row, c.field)} as={c.as} />
                    </td>
                  ))}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    case "list": {
      const rows = asRows(value);
      if (rows.length === 0) return <BlockNotice text={`${block.source.rpc} returned nothing to list.`} />;
      return (
        <div>
          {block.title && <BlockTitle>{block.title}</BlockTitle>}
          <ul className="space-y-1">
            {rows.slice(0, block.source.limit ?? rows.length).map((row, i) => (
              <li key={i} className="flex items-start gap-2 text-xs p-text-2">
                <span className="p-dot-neutral size-1.5 rounded-full mt-1.5 shrink-0" />
                <span>{scalarText(block.field ? resolveViewPath(row, block.field) : row)}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    case "kv":
      return (
        <div>
          {block.title && <BlockTitle>{block.title}</BlockTitle>}
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            {block.rows.map((row) => (
              <div key={row.field} className="contents">
                <dt className="p-text-3">{row.label}</dt>
                <dd className="p-text-2 min-w-0 truncate"><Cell value={value === undefined ? undefined : resolveViewPath(value, row.field)} as={row.as} /></dd>
              </div>
            ))}
          </dl>
        </div>
      );
  }
}

/**
 * Consecutive stats are one row, not a stack of full-width banners.
 *
 * A dashboard's stats are a comparison, so they read across; a lone stat
 * stretched to the panel width reads as an empty header instead of a number.
 * Grouping happens here rather than in the spec so the agent does not have to
 * describe layout — it says what the numbers are, and this decides the shape.
 */
function BlockList({ blocks, slug, sources }: {
  blocks: readonly ViewBlock[]; slug: string; sources: Map<string, SourceState>;
}) {
  const groups: Array<{ stats: ViewLeafBlock[] } | { block: ViewBlock; index: number }> = [];
  blocks.forEach((block, i) => {
    if (block.type !== "stat") { groups.push({ block, index: i }); return; }
    const last = groups.at(-1);
    if (last && "stats" in last) last.stats.push(block);
    else groups.push({ stats: [block] });
  });

  return (
    <div className="space-y-5">
      {groups.map((group, i) => "stats" in group
        ? (
          <div key={i} className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
            {group.stats.map((stat, j) => <LeafBlock key={j} block={stat} sources={sources} />)}
          </div>
        )
        : <Block key={i} block={group.block} slug={slug} index={group.index} sources={sources} />)}
    </div>
  );
}

function Block({ block, slug, index, sources }: {
  block: ViewBlock; slug: string; index: number; sources: Map<string, SourceState>;
}) {
  if (block.type !== "section") return <LeafBlock block={block} sources={sources} />;
  return (
    // The section id is keyed on position, not title: the agent may rename a
    // section, and a fold the owner chose should survive that.
    <Section id={`view.${slug}.${index}`} title={block.title} icon={<SparkleIcon size={13} className="p-text-3" />}>
      <BlockList blocks={block.blocks} slug={slug} sources={sources} />
    </Section>
  );
}

// ── the surface ─────────────────────────────────────────────────────────────

export function AgentViewSurface({ slug, rpc }: { slug: string; rpc: Rpc }) {
  const [spec, setSpec] = useState<ViewSpec | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [sources, setSources] = useState<Map<string, SourceState>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSource, setShowSource] = useState(false);
  // The interval reads the newest spec without re-arming on every data refresh.
  const specRef = useRef<ViewSpec | null>(null);
  specRef.current = spec;

  const loadData = useCallback(async (loaded: ViewSpec) => {
    const results = await Promise.all(collectSources(loaded).map(async (source): Promise<[string, SourceState]> => {
      try {
        const args = source.limit === undefined ? [] : [source.limit];
        const data = v.parse(JsonValueSchema, await rpc(source.rpc, args));
        return [sourceKey(source), { data }];
      } catch (err) {
        return [sourceKey(source), { error: renderThrownChain({ cause: err }) }];
      }
    }));
    setSources(new Map(results));
  }, [rpc]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = v.parse(AgentViewResponseSchema, await rpc("getAgentView", [slug]));
      if (!result.ok || !result.spec) {
        setSpec(null);
        setError(result.error ?? "This view could not be read.");
        return;
      }
      setSpec(result.spec);
      setVersion(result.version ?? null);
      await loadData(result.spec);
    } catch (err) {
      setError(renderThrownChain({ cause: err }));
    } finally {
      setLoading(false);
    }
  }, [rpc, slug, loadData]);

  useEffect(() => { setLoading(true); void load(); }, [load]);

  useEffect(() => {
    const every = spec?.refreshMs;
    if (!every) return;
    const timer = setInterval(() => {
      const current = specRef.current;
      if (current) void loadData(current);
    }, every);
    return () => clearInterval(timer);
  }, [spec?.refreshMs, loadData]);

  const json = useMemo(() => (spec ? JSON.stringify(spec, null, 2) : ""), [spec]);

  if (loading) return <div className="flex justify-center py-16"><Loader /></div>;

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Provenance. Deliberately the first thing in the scroll, and never
          scrolled away by the view's own content — see the file header. */}
      <div className="flex items-center gap-2 flex-wrap">
        <SparkleIcon size={14} className="p-text-3" />
        <span className="p-eyebrow p-text-3">Written by Kinu</span>
        <span className="p-text-3 text-xs">·</span>
        <span className="text-sm font-medium p-text">{spec?.title ?? slug}</span>
        {version !== null && <span className="text-[10px] p-text-3 p-num">v{version}</span>}
        <div className="flex-1" />
        {spec && (
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            aria-pressed={showSource}
            className="p-btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs cursor-pointer"
          >
            <CodeIcon size={12} />View source
          </button>
        )}
        <button
          type="button"
          onClick={() => { void load(); }}
          className="p-btn-ghost inline-flex items-center gap-1 px-2 py-1 text-xs cursor-pointer"
        >
          <ArrowClockwiseIcon size={12} />Refresh
        </button>
      </div>

      {spec?.subtitle && <p className="text-xs p-text-3 -mt-2">{spec.subtitle}</p>}

      {error && (
        <div className="p-notice-danger rounded-lg px-3 py-2 text-xs flex items-start gap-2">
          <WarningIcon size={13} className="mt-0.5 shrink-0" />
          {/* The reason comes from core and carries no trailing punctuation, so
              the remedy gets its own line rather than running into it. */}
          <div className="space-y-1 min-w-0">
            <p className="break-words">{error}</p>
            <p className="opacity-80">Revert it from the Evolution Changelog, or ask Kinu to rewrite it.</p>
          </div>
        </div>
      )}

      {showSource && spec && (
        <pre className="p-recessed rounded-lg p-3 text-[11px] font-mono overflow-x-auto max-h-[320px] overflow-y-auto m-0">
          {json}
        </pre>
      )}

      {spec
        ? (
          <BlockList blocks={spec.blocks} slug={slug} sources={sources} />
        )
        : !error && (
          <EmptyState
            icon={<SparkleIcon size={28} />}
            title="This view is empty"
            hint="Ask Kinu to publish a dashboard here."
          />
        )}
    </div>
  );
}
