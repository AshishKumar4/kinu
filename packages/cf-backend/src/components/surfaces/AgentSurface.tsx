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
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  FingerprintIcon, PackageIcon, MagnifyingGlassIcon, DatabaseIcon, FolderOpenIcon, BrainIcon,
  CaretRightIcon, GitBranchIcon, UsersIcon,
} from "@phosphor-icons/react";
import { ScoreBar } from "@/components/ui/score-bar";
import type { AgentStatus } from "@/hooks/use-kinu";
import type { ToolInfo, MemoryEntry, Rpc } from "@/lib/protocol";
import { MarkdownContent, EmptyState, EMPTY_HINTS, Section } from "./shared";
import { ScaffoldLineage } from "./ScaffoldLineage";
import { GepaView, QualityView } from "./evolution-panels";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { agentTitle } from "@/components/SubordinateTabs";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import * as v from "valibot";

interface Fact { key: string; value: unknown; confidence: number; source: string; lastObservedAt: number }

export interface AgentSurfaceProps {
  /** The workspace snapshot every pane below is fed by. A tri-state rather
   *  than a nullable status, because "still coming" and "came back broken"
   *  are different things to draw and neither of them is "none". */
  snapshot: AsyncResource<AgentStatus>;
  tools: ToolInfo[];
  memory: MemoryEntry[];
  memoryContent: string;
  onSearchMemory: (q: string) => void;
  /** Re-run the snapshot. The panes offer it when their read failed. */
  onRetryLoad: () => void;
  rpc: Rpc;
}

/**
 * Says how the model reaches a capability, and whether this agent has it.
 *
 * `exposure` is the registry's DECLARED reach (`TOOL_REACH`): `native` = the
 * turn hands it to the model as a tool definition, `codemode` = it exists only
 * as a namespace inside an `execute_tools` program, `both` = both, over one
 * dispatcher. That is a real difference in how the agent has to call it and
 * therefore worth a word on screen.
 *
 * It used to be a two-valued guess the orchestrator made from the assembled
 * ToolSet — `native` if present, `codemode` otherwise — which had no way to say
 * "this agent has it on neither surface". `report` is the one deps-gated
 * builtin, so on an orchestrator it fell into the else-branch and this badge
 * read "code mode": false twice over, because `report` is native wherever it
 * exists and its `report.*` namespace is wired only on subordinates. Absence is
 * now its own signal (`wired`), so neither word has to carry it.
 */
function ExposureBadge({ exposure, wired }: { exposure: ToolInfo["exposure"]; wired: boolean }) {
  const label = exposure === "both" ? "native · code mode" : exposure === "native" ? "native" : "code mode";
  const reach = exposure === "both"
    ? "The model can call this tool, and so can an execute_tools program."
    : exposure === "native"
      ? "The model can call this tool."
      : "Only an execute_tools program can call this tool.";
  return (
    <>
      <span
        className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-mono ${
          wired ? (exposure === "native" ? "p-badge-neutral" : "p-accent-subtle p-accent") : "p-badge-neutral p-text-3"
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
          <Badge variant="secondary">{tool.learned ? "Learned" : "Built-in"}</Badge>
          <ExposureBadge exposure={tool.exposure} wired={tool.wired} />
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

export function AgentSurface(
  { snapshot, tools, memory, memoryContent, onSearchMemory, onRetryLoad, rpc }: AgentSurfaceProps,
) {
  const [memorySearch, setMemorySearch] = useState("");
  // "No world model" is a claim about what this agent has learned, so it may
  // only be made about a listing that actually came back.
  const loadFacts = useCallback(() => rpc<Fact[]>("getFacts", [100]), [rpc]);
  const { resource: factsResource, reload: reloadFacts } = useAsyncResource(loadFacts);
  const facts = lastValue(factsResource) ?? [];
  const as = lastValue(snapshot);

  /** What a pane shows while the snapshot has produced nothing for it: a
   *  spinner for a read still coming, a retry for one that came back broken.
   *  Neither carries the reason — the page banner gives it once, and a pane
   *  repeating it is one outage said four times. Every pane below asks for
   *  this instead of reporting "none" for a read that never arrived. */
  const unloaded = (what: string) => snapshot.status === "error"
    ? <LoadFailure what={what} onRetry={onRetryLoad} />
    : <div className="flex items-center justify-center h-32"><Loader size="base" /></div>;

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
                header and the tab all carry. Beneath it, ONE identifier: the
                slug, which is the workspace's address and its id. There is no
                second one to show: `workspace_identity.id` is
                `idFromName(slug)` on this backend, so it restated the line
                above it in hex. */}
            <div className="min-w-0">
              <div className="p-title p-text truncate" title={as.displayName}>{as.displayName}</div>
              <div className="p-meta p-text-3 font-mono truncate" title={as.name}>{as.name}</div>
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
              <div key={l} className={`grid grid-cols-[96px_minmax(0,1fr)] gap-3.5 py-2.5 border-b border-dashed border-[var(--c-dash)] last:border-0 items-baseline ${l === "Model" ? "font-mono" : ""}`}>
                <span className="text-xs p-text-4">{l}</span>
                <span className={`text-[13px] p-text-2 min-w-0 break-words ${l === "Model" ? "text-[11px] p-text-3" : "text-right"}`}>{v}</span>
              </div>
            ))}
          </div>
        </Section>
      ) : unloaded("this agent")}

      {/* Memory */}
      <Section id="memory" title="Memory" icon={<DatabaseIcon size={14} className="p-text-2" />}>
        <div className="space-y-3">
          <div className="relative">
            <MagnifyingGlassIcon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 p-text-3" />
            <input value={memorySearch} onChange={(e) => { setMemorySearch(e.target.value); onSearchMemory(e.target.value); }}
              placeholder="Search memory…" className="w-full rounded-lg border p-border p-elevated pl-9 pr-3 py-2 text-sm p-text focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)] placeholder:p-text-3 transition-all" />
          </div>
          {!memorySearch && memoryContent ? (
            <div className="p-card p-4">
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
            as === null
              ? unloaded("memory")
              : <EmptyState icon={<FolderOpenIcon size={28} />} title="No memories yet" hint={EMPTY_HINTS.memory} />
          ) : memory.length === 0 ? (
            <EmptyState icon={<MagnifyingGlassIcon size={28} />} title="No results" />
          ) : memory.map((entry, i) => (
            <div key={i} className="p-card p-3">
              <span className="text-[11px] font-mono p-accent">{entry.updatedAt}</span>
              <p className="text-xs p-text-2 line-clamp-4 whitespace-pre-wrap mt-1 leading-relaxed">{entry.content}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* World model — keyed agent_facts the agent remembers across turns. */}
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
                {f.confidence < 1 && <span className="text-[10px] p-text-3 shrink-0">{(f.confidence * 100).toFixed(0)}%</span>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Subordinates — the mock's roster card. Real data off the same
          @callable the chat strip uses; Message opens that subordinate's chat. */}
        <SubordinatesCard rpc={rpc} workspaceName={as?.name ?? ""} />

      {/* Tools (CraftStore + builtins) */}
      <Section id="tools" title="Tools" icon={<PackageIcon size={14} className="p-text-2" />}
        badge={tools.length > 0 ? <Badge variant="secondary">{tools.length}</Badge> : undefined}>
        <div className="space-y-2">
          {tools.length > 0
            ? tools.map((tool) => <ToolCard key={tool.name} tool={tool} />)
            : as === null
              ? unloaded("tools")
              : <EmptyState icon={<PackageIcon size={28} />} title="No tools discovered yet" hint={EMPTY_HINTS.tools} />}
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

/** One durable helper of this workspace, as the mock draws it: dot, name,
 *  role line, and a Message button into its chat. */
function SubordinatesCard({ rpc, workspaceName }: { rpc: Rpc; workspaceName: string }) {
  const loadRoster = useCallback(() => rpc<SubordinateRow[]>("listSubordinates", []), [rpc]);
  const { resource, reload } = useAsyncResource(loadRoster);
  const roster = (lastValue(resource) ?? []).filter((sub) => sub.status !== "dismissed");

  return (
    <Section id="subordinates" title="Agents" icon={<UsersIcon size={14} className="p-text-2" />}
      badge={roster.length > 0 ? <Badge variant="secondary">{roster.length}</Badge> : undefined}>
      {resource.status === "error" ? (
        <LoadFailure what="the agent roster" message={resource.message} onRetry={reload} />
      ) : roster.length === 0 ? (
        <p className="text-xs leading-relaxed p-text-4">
          No standing helpers. Each runs its own loop, outlives the turn, and shares workspace files.
          Hire one from the chat tabs.
        </p>
      ) : (
        <div className="p-group">
          {roster.map((sub) => (
            <div key={sub.name} className="flex items-center gap-2.5 px-4 py-3">
              <span className={`size-1.5 shrink-0 rounded-full ${sub.status === "working" ? "p-dot-success p-dot-pulse" : sub.status === "awaiting_input" ? "p-dot-warning" : "bg-[var(--c-fill)] border p-border"}`} />
              <div className="min-w-0 flex-1">
                <div className={`truncate text-[13px] ${sub.displayName ? "p-text-2" : "italic p-text-3"}`}>{agentTitle(sub.displayName)}</div>
                <div className="truncate text-[11px] p-text-4">{sub.role}{sub.currentTask ? ` · ${sub.currentTask}` : ""}</div>
              </div>
              <Link
                to={`/workspace/${workspaceName}/agents/${sub.name}`}
                className="shrink-0 text-[11.5px] font-semibold p-accent"
              >Message</Link>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

interface SubordinateRow {
  name: string;
  displayName: string;
  role: string;
  status: string;
  currentTask: string | null;
}
