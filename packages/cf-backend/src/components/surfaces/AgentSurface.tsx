/**
 * Agent: what this agent is and whether it is getting better. Evolution holds lineage,
 * GEPA passes and the quality scoreboard together; quality rows are keyed by `scaffoldVersion`.
 */
import { useCallback, useState } from "react";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  FingerprintIcon, PackageIcon, MagnifyingGlassIcon, DatabaseIcon, FolderOpenIcon, BrainIcon,
  CaretRightIcon, GitBranchIcon,
} from "@phosphor-icons/react";
import type { AgentStatus } from "@/hooks/use-kinu";
import type { ToolInfo, MemoryEntry, Rpc } from "@kinu.run/core";
import { MarkdownContent, EmptyState, Section } from "./shared";
import { timeAgo, workspaceDisplayTitle } from "@kinu.run/core";
import { ScaffoldLineage } from "./ScaffoldLineage";
import { GepaView, QualityView } from "./evolution-panels";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import * as v from "valibot";

interface Fact { key: string; value: unknown; confidence: number; source: string; lastObservedAt: number }

export interface AgentSurfaceProps {
  /** Tri-state: "still coming" and "came back broken" differ, and neither is "none". */
  snapshot: AsyncResource<AgentStatus>;
  tools: ToolInfo[];
  memory: MemoryEntry[];
  memoryContent: string;
  onSearchMemory: (q: string) => void;
  onRetryLoad: () => void;
  rpc: Rpc;
}

const EXPOSURE: Record<ToolInfo["exposure"], { label: string; reach: string; tone: string }> = {
  native: {
    label: "native",
    reach: "The model can call this tool.",
    tone: "p-badge-neutral",
  },
  codemode: {
    label: "code mode",
    reach: "Only an eval program can call this tool.",
    tone: "p-accent-subtle p-accent",
  },
  both: {
    label: "native · code mode",
    reach: "The model can call this tool, and so can an eval program.",
    tone: "p-accent-subtle p-accent",
  },
};

/**
 * `exposure` is the registry's declared reach (`TOOL_REACH`); `wired` carries absence
 * separately, since a deps-gated builtin like `report` exists on neither surface on an orchestrator.
 */
function ExposureBadge({ exposure, wired }: { exposure: ToolInfo["exposure"]; wired: boolean }) {
  const { label, reach, tone } = EXPOSURE[exposure];

  return (
    <>
      <span
        className={`inline-flex items-center rounded-full px-1.5 py-0.5 p-t-status ${
          wired ? tone : "p-badge-neutral p-text-3"
        }`}
        title={reach}
      >
        {label}
      </span>
      {!wired && (
        <span
          className="p-meta p-text-3"
          title="This agent does not use this capability on any surface this turn."
        >
          not on this agent
        </span>
      )}
    </>
  );
}

/** The registry's one-line summary, opening to the newline-structured docstring. */
function ToolCard({ tool }: { tool: ToolInfo }) {
  const [open, setOpen] = useState(false);
  const hasDetail = tool.description.trim() !== tool.summary.trim();

  return (
    <div className="p-card">
      <button
        type="button"
        onClick={() => hasDetail && setOpen(!open)}
        aria-expanded={hasDetail ? open : undefined}
        className={`flex w-full flex-col gap-1 px-3 py-2.5 text-left ${hasDetail ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <PackageIcon size={13} className="p-accent shrink-0" />
          <span className="p-title font-mono p-text">{tool.name}</span>
          <ExposureBadge exposure={tool.exposure} wired={tool.wired} />
          {tool.usageCount > 0 && <span className="p-meta p-text-3 ml-auto">{tool.usageCount} uses</span>}
          {hasDetail && (
            <CaretRightIcon
              size={11}
              className={`shrink-0 p-text-3 transition-transform duration-150 ${tool.usageCount > 0 ? "" : "ml-auto"} ${open ? "rotate-90" : ""}`}
            />
          )}
        </span>
        {/* Open replaces the headline: the docstring's first line is the summary. */}
        {open
          ? <span className="p-meta p-text-2 whitespace-pre-line">{tool.description}</span>
          : <span className="p-row-text p-text-2">{tool.summary}</span>}
      </button>
    </div>
  );
}

export function AgentSurface(
  { snapshot, tools, memory, memoryContent, onSearchMemory, onRetryLoad, rpc }: AgentSurfaceProps,
) {
  const [memorySearch, setMemorySearch] = useState("");
  // "No world model" may only be claimed about a listing that came back.
  const loadFacts = useCallback(() => rpc<Fact[]>("getFacts", [100]), [rpc]);
  const { resource: factsResource, reload: reloadFacts } = useAsyncResource(loadFacts);
  const facts = lastValue(factsResource) ?? [];
  const as = lastValue(snapshot);

  /** Spinner while the read is coming, retry once it failed; the page banner gives the reason once. */
  const unloaded = (what: string) => snapshot.status === "error"
    ? <LoadFailure what={what} onRetry={onRetryLoad} />
    : <div className="flex items-center justify-center h-32"><Loader size="base" /></div>;

  const noMemories = as === null ? unloaded("memory") : <EmptyState icon={<FolderOpenIcon size={28} />} title="No memories yet" />;
  const noTools = as === null ? unloaded("tools") : <EmptyState icon={<PackageIcon size={28} />} title="No tools yet" />;

  return (
    <div className="space-y-6 animate-fade-in">
      {as ? (
        <Section id="identity" title="Identity" icon={<FingerprintIcon size={14} className="p-text-2" />}>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-11 rounded-xl flex items-center justify-center p-fill border p-border">
              <FingerprintIcon size={22} className="p-accent" />
            </div>
            {/* The workspace title as shown elsewhere, then the slug. `workspace_identity.id` is
                `idFromName(slug)`, so it would only restate the slug in hex. */}
            <div className="min-w-0">
              <div className="p-title p-text truncate" title={workspaceDisplayTitle({ name: as.name, displayName: as.displayName })}>{workspaceDisplayTitle({ name: as.name, displayName: as.displayName })}</div>
              <div className="p-meta p-text-3 font-mono truncate" title={as.name}>{as.name}</div>
            </div>
          </div>
          <div className="space-y-0">
            {([
              ["Mission", as.purpose],
              ["Model", as.model],
              ["Scaffold", `v${as.scaffoldVersion}`],
              ["MCTS Nodes", String(as.searchNodeCount)],
              ["Messages", String(as.messageCount)],
              ["Created", new Date(as.createdAt).toLocaleString()],
            ]).map(([l, value]) => (
              <div key={l} className={`grid grid-cols-[96px_minmax(0,1fr)] gap-3.5 py-2.5 border-b border-dashed border-[var(--c-dash)] last:border-0 items-baseline ${l === "Model" ? "font-mono" : ""}`}>
                <span className="text-xs p-text-4">{l}</span>
                <span className={`p-row-text p-text-2 min-w-0 break-words ${l === "Model" ? "p-annotation p-text-3" : "text-right"}`}>{value}</span>
              </div>
            ))}
          </div>
        </Section>
      ) : unloaded("this agent")}

      <Section id="memory" title="Memory" icon={<DatabaseIcon size={14} className="p-text-2" />}>
        <div className="space-y-3">
          <div className="relative">
            <MagnifyingGlassIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 p-text-3" />
            <input value={memorySearch} onChange={(e) => { setMemorySearch(e.target.value); onSearchMemory(e.target.value); }}
              placeholder="Search memory…" className="w-full rounded-lg border p-border p-elevated pl-9 pr-3 py-2 text-sm p-text focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)] placeholder:p-text-3 transition-all" />
          </div>
          {memorySearch === "" && (memoryContent === "" ? noMemories : (
            <div className="p-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <DatabaseIcon size={13} className="p-accent" />
                <span className="text-xs font-mono p-accent">memory/MEMORY.md</span>
                <span className="p-meta p-text-3 ml-auto">{memoryContent.length} chars</span>
              </div>
              <div className="prose-chat p-text max-h-[500px] overflow-y-auto">
                <MarkdownContent content={memoryContent} />
              </div>
            </div>
          ))}
          {memorySearch !== "" && (memory.length === 0 ? (
            <EmptyState icon={<MagnifyingGlassIcon size={28} />} title="No results" />
          ) : memory.map((entry, i) => (
            <div key={i} className="p-card p-3">
              <span className="p-annotation p-accent">{entry.updatedAt}</span>
              <p className="text-xs p-text-2 line-clamp-4 whitespace-pre-wrap mt-1 leading-relaxed">{entry.content}</p>
            </div>
          )))}
        </div>
      </Section>

      {/* World model: keyed agent_facts the agent remembers across turns. */}
      {factsResource.status === "error" ? (
        <Section id="world-model" title="World model" defaultOpen={false}
          icon={<BrainIcon size={14} className="p-text-2" />}>
          <LoadFailure what="the world model" message={factsResource.message} onRetry={reloadFacts} />
        </Section>
      ) : facts.length > 0 && (
        <Section id="world-model" title="World model" defaultOpen={false}
          icon={<BrainIcon size={14} className="p-text-2" />}
          badge={<Badge variant="secondary">{facts.length}</Badge>}>
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {facts.map((f) => (
              <div key={f.key} className="flex items-start gap-2 px-3 py-1.5 border-b p-border last:border-0">
                <span className="font-mono p-accent shrink-0">{f.key}</span>
                <span className="p-text-2 truncate flex-1 text-right">{v.is(v.string(), f.value) ? f.value : JSON.stringify(f.value)}</span>
                {f.confidence < 1 && <span className="p-meta p-text-3 shrink-0">{(f.confidence * 100).toFixed(0)}%</span>}
                {f.source !== '' && <span className="p-meta p-text-3 shrink-0">via {f.source}</span>}
                <span className="p-meta p-text-3 shrink-0">{timeAgo(f.lastObservedAt)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Tools (CraftStore + builtins) */}
      <Section id="tools" title="Tools" icon={<PackageIcon size={14} className="p-text-2" />}
        badge={tools.length > 0 ? <Badge variant="secondary">{tools.length}</Badge> : undefined}>
        <div className="space-y-2">
          {tools.length > 0
            ? tools.map((tool) => <ToolCard key={tool.name} tool={tool} />)
            : noTools}
        </div>
      </Section>

      <Section id="evolution" title="Evolution" defaultOpen={false}
        icon={<GitBranchIcon size={14} className="p-text-2" />}
        badge={as ? <Badge variant="secondary">v{as.scaffoldVersion}</Badge> : undefined}>
        <div className="space-y-5">
          {as && <ScaffoldLineage rpc={rpc} currentVersion={as.scaffoldVersion} />}
          <EvolutionBlock title="Self-tuning" hint="GEPA passes propose candidates for the next scaffold version.">
            <GepaView rpc={rpc} />
          </EvolutionBlock>
          <EvolutionBlock title="Quality" hint="Replay loss, correction rate and calibration, per scaffold version.">
            <QualityView rpc={rpc} />
          </EvolutionBlock>
        </div>
      </Section>
    </div>
  );
}

/** Not a Section: nested collapsibles inside one are a fold to fight. */
function EvolutionBlock({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="p-eyebrow">{title}</div>
      <p className="p-meta p-text-3">{hint}</p>
      {children}
    </section>
  );
}
