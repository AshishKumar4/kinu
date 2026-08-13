/**
 * Agent — what this agent is, and whether it is getting better.
 *
 * Identity · Memory · World model · Tools · Evolution. Everything the agent IS,
 * as opposed to what it made (Output), what it is working through (Work), how
 * it explored (Exploration), or where it can act (Environment).
 *
 * Evolution is the whole trajectory in one place: the scaffold lineage with its
 * shadow verdict and promote/rollback, the GEPA passes that generate candidates
 * for the next version, and the quality scoreboard that says whether the
 * versions are measurably better. The last two used to sit under Exploration,
 * beside the fork strategies, purely because the strategy code is adjacent —
 * and the quality rows are literally keyed by `scaffoldVersion`, so beside the
 * lineage they measure is where they read as one loop.
 *
 * The changelog left for Work: a self-change is an EVENT, and "what happened
 * while I was away" is not a question anyone opens a CV to answer.
 */
import { useState, useEffect } from "react";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  FingerprintIcon, PackageIcon, MagnifyingGlassIcon, DatabaseIcon, FolderOpenIcon, BrainIcon,
  CaretRightIcon, GitBranchIcon,
} from "@phosphor-icons/react";
import { ScoreBar } from "@/components/ui/score-bar";
import type { AgentStatus } from "@/hooks/use-proteus";
import type { ToolInfo, MemoryEntry, Rpc } from "@/lib/protocol";
import { MarkdownContent, EmptyState, EMPTY_HINTS, Section } from "./shared";
import { ScaffoldLineage } from "./ScaffoldLineage";
import { GepaView, QualityView } from "./evolution-panels";

interface Fact { key: string; value: unknown; confidence: number; source: string; lastObservedAt: number }

export interface AgentSurfaceProps {
  agentStatus: AgentStatus | null;
  tools: ToolInfo[];
  memory: MemoryEntry[];
  memoryContent: string;
  onSearchMemory: (q: string) => void;
  rpc: Rpc;
}

/**
 * Says how the model reaches a capability. `native` means the turn hands it to
 * the model as a tool definition; `codemode` means it exists only as a
 * namespace inside an `execute_tools` program, which is a real difference in
 * how the agent has to call it and therefore worth a word on screen.
 *
 * The value is derived by the orchestrator from the assembled tool surface —
 * this renders it, it does not decide it.
 */
function ExposureBadge({ exposure }: { exposure: ToolInfo["exposure"] }) {
  const native = exposure === "native";
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-mono ${native ? "p-badge-neutral" : "p-accent-subtle p-accent"}`}
      title={native
        ? "Passed to the model as a tool definition."
        : "Reachable only from inside an execute_tools program."}
    >
      {native ? "native" : "code mode"}
    </span>
  );
}

/**
 * One tool, as a row rather than an essay.
 *
 * A builtin's docstring is the full contract the model is given — summary,
 * when to use, when not to, doctrine, returns — and nine of them rendered as
 * flowing paragraphs is the wall this surface had become: every card the same
 * ink, the same weight, no edge you could find without reading. The row shows
 * the registry's own one-line summary and opens to the docstring, which is
 * newline-structured at the source and so is rendered as the lines it is.
 */
function ToolCard({ tool }: { tool: ToolInfo }) {
  const [open, setOpen] = useState(false);
  // A crafted tool's description IS its summary; there is nothing behind it.
  const hasDetail = tool.description.trim() !== tool.summary.trim();

  return (
    <div className="p-card rounded-lg">
      <button
        type="button"
        onClick={() => hasDetail && setOpen(!open)}
        aria-expanded={hasDetail ? open : undefined}
        className={`flex w-full flex-col gap-1 px-3 py-2.5 text-left ${hasDetail ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <PackageIcon size={13} className="p-accent shrink-0" />
          <span className="p-title font-mono p-text">{tool.name}</span>
          <Badge variant="secondary">{tool.learned ? "Learned" : "Built-in"}</Badge>
          <ExposureBadge exposure={tool.exposure} />
          {tool.usageCount > 0 && <span className="p-meta p-text-3 ml-auto">{tool.usageCount} uses</span>}
          {hasDetail && (
            <CaretRightIcon
              size={11}
              className={`shrink-0 p-text-3 transition-transform duration-150 ${tool.usageCount > 0 ? "" : "ml-auto"} ${open ? "rotate-90" : ""}`}
            />
          )}
        </span>
        {/* Open REPLACES the headline rather than appending to it: the
            docstring's first line is the summary, so showing both prints it
            twice — and recovering "the rest" would mean splitting a string
            whose shape belongs to the model, not to this component. */}
        {open
          ? <span className="p-meta p-text-2 whitespace-pre-line leading-[18px]">{tool.description}</span>
          : <span className="p-row-text p-text-2">{tool.summary}</span>}
      </button>
      {tool.learned && <div className="px-3 pb-2.5"><ScoreBar value={tool.qualityScore} /></div>}
    </div>
  );
}

export function AgentSurface({ agentStatus: as, tools, memory, memoryContent, onSearchMemory, rpc }: AgentSurfaceProps) {
  const [memorySearch, setMemorySearch] = useState("");
  const [facts, setFacts] = useState<Fact[]>([]);
  useEffect(() => { rpc<Fact[]>("getFacts", [100]).then(setFacts).catch(() => {}); }, [rpc]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Identity */}
      {as ? (
        <Section id="identity" title="Identity" icon={<FingerprintIcon size={14} className="p-text-2" />}>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-11 rounded-xl flex items-center justify-center p-fill border p-border">
              <FingerprintIcon size={22} className="p-accent" />
            </div>
            {/* The heading is the agent's NAME as everything else in the app
                shows it — the mission-derived title the sidebar, the chat
                header and the tab all carry. `as.name` is the URL slug
                (`my-personal-for-helping-9935d3`), which is addressing, not
                identity; it belongs beside the id. */}
            <div className="min-w-0">
              <div className="p-title p-text truncate" title={as.displayName}>{as.displayName}</div>
              <div className="p-meta p-text-3 font-mono truncate" title={`${as.name} · ${as.id}`}>
                {as.name} · {as.id.slice(0, 12)}…
              </div>
            </div>
          </div>
          <div className="space-y-0">
            {([
              ["Mission", as.purpose],
              ["Model", as.model],
              ["Scaffold", `v${as.scaffoldVersion}`],
              ["MCTS Nodes", String(as.searchNodeCount)],
              ["Crafted Tools", String(as.craftedToolCount)],
              ["Messages", String(as.messageCount)],
              ["Created", new Date(as.createdAt).toLocaleString()],
            ]).map(([l, v]) => (
              <div key={l} className="flex items-center justify-between py-2.5 border-b p-border last:border-0">
                <span className="text-sm p-text-2">{l}</span>
                <span className="text-sm p-text max-w-[60%] text-right">{v}</span>
              </div>
            ))}
          </div>
        </Section>
      ) : <div className="flex items-center justify-center h-32"><Loader size="base" /></div>}

      {/* Memory */}
      <Section id="memory" title="Memory" icon={<DatabaseIcon size={14} className="p-text-2" />}>
        <div className="space-y-3">
          <div className="relative">
            <MagnifyingGlassIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 p-text-3" />
            <input value={memorySearch} onChange={(e) => { setMemorySearch(e.target.value); onSearchMemory(e.target.value); }}
              placeholder="Search memory…" className="w-full rounded-lg border p-border p-elevated pl-9 pr-3 py-2 text-sm p-text focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)] placeholder:p-text-3 transition-all" />
          </div>
          {!memorySearch && memoryContent ? (
            <div className="p-card rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <DatabaseIcon size={13} className="p-accent" />
                <span className="text-xs font-mono p-accent">memory/MEMORY.md</span>
                <span className="text-[10px] p-text-3 ml-auto">{memoryContent.length} chars</span>
              </div>
              <div className="prose-chat p-text max-h-[500px] overflow-y-auto">
                <MarkdownContent content={memoryContent} />
              </div>
            </div>
          ) : !memorySearch ? (
            <EmptyState icon={<FolderOpenIcon size={28} />} title="No memories yet" hint={EMPTY_HINTS.memory} />
          ) : memory.length === 0 ? (
            <EmptyState icon={<MagnifyingGlassIcon size={28} />} title="No results" />
          ) : memory.map((entry, i) => (
            <div key={i} className="p-card rounded-lg p-3">
              <span className="text-[11px] font-mono p-accent">{entry.updatedAt}</span>
              <p className="text-xs p-text-2 line-clamp-4 whitespace-pre-wrap mt-1 leading-relaxed">{entry.content}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* World model — keyed agent_facts the agent remembers across turns. */}
      {facts.length > 0 && (
        <Section id="world-model" title="World model" defaultOpen={false}
          icon={<BrainIcon size={14} className="p-text-2" />}
          badge={<Badge variant="secondary">{facts.length}</Badge>}>
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {facts.map((f) => (
              <div key={f.key} className="flex items-start gap-2 px-3 py-1.5 border-b p-border last:border-0">
                <span className="font-mono p-accent shrink-0">{f.key}</span>
                <span className="p-text-2 truncate flex-1 text-right">{typeof f.value === "string" ? f.value : JSON.stringify(f.value)}</span>
                {f.confidence < 1 && <span className="text-[10px] p-text-3 shrink-0">{(f.confidence * 100).toFixed(0)}%</span>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Tools (CraftStore + builtins) */}
      <Section id="tools" title="Tools" icon={<PackageIcon size={14} className="p-text-2" />}
        badge={tools.length > 0 ? <Badge variant="secondary">{tools.length}</Badge> : undefined}>
        <div className="space-y-2">
          {tools.length === 0 ? (
            <EmptyState icon={<PackageIcon size={28} />} title="No tools discovered yet" hint={EMPTY_HINTS.tools} />
          ) : tools.map((tool) => <ToolCard key={tool.name} tool={tool} />)}
        </div>
      </Section>

      {/* Evolution — the agent's versions, where the next candidates come from,
          and whether the versions are measurably better. One loop, one place. */}
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

/** A labelled block inside Evolution. Not a Section: three nested collapsibles
 *  inside one is a fold you have to fight, and these three are one story. */
function EvolutionBlock({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="text-[10px] uppercase tracking-normal p-text-3">{title}</div>
      <p className="text-[10px] p-text-3 leading-relaxed">{hint}</p>
      {children}
    </section>
  );
}
