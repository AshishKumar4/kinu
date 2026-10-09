/**
 * Agent: what this agent is and whether it is getting better. Evolution holds lineage,
 * GEPA passes and the quality scoreboard together; quality rows are keyed by `scaffoldVersion`.
 */
import { useCallback, useState } from "react";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  FingerprintIcon, MagnifyingGlassIcon, DatabaseIcon, FolderOpenIcon, BrainIcon, GitBranchIcon,
} from "@phosphor-icons/react";
import type { AgentStatus, ReadMoves } from "@/hooks/use-kinu";
import type { JsonValue, MemoryEntry, Rpc } from "@kinu.run/core";
import { Effect } from "effect";
import { attempt, detach, renderThrownChain } from "@kinu.run/core/obs";
import { putAccountFact } from "../../lib/user-api";
import { MarkdownContent, EmptyState, Section } from "./shared";
import { timeAgo, workspaceDisplayTitle } from "@kinu.run/core";
import { ScaffoldLineage } from "./ScaffoldLineage";
import { GepaView, QualityView } from "./evolution-panels";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import * as v from "valibot";

interface Fact { key: string; value: JsonValue; confidence: number; source: string; lastObservedAt: number }

type PromoteState = "idle" | "saving" | "kept" | { readonly failed: string };

/**
 * This workspace's fact, kept for every workspace and agent of the account: the owner's own promotion, so it is kept at
 * once, with this workspace named as where it came from (Settings → Memory shows it).
 */
function PromoteFact({ fact, workspace }: { fact: Fact; workspace: string }) {
  const [state, setState] = useState<PromoteState>("idle");

  if (state === "kept") return <span className="p-meta p-success shrink-0" data-world-model-promoted>Kept for every workspace</span>;

  const promote = () => Effect.sync(() => { setState("saving"); }).pipe(
    Effect.andThen(attempt({ doing: "keeping this fact for every workspace", otherwise: "io" }, () => putAccountFact(fact.key, fact.value, workspace))),
    Effect.match({ onSuccess: () => { setState("kept"); }, onFailure: (failed) => { setState({ failed: renderThrownChain({ cause: failed }) }); } }),
  );

  const failed = typeof state === "object" ? state.failed : null;
  let label = failed === null ? "Keep for every workspace" : "Retry: keep for every workspace";

  if (state === "saving") label = "Keeping…";

  return (
    <button type="button" className="p-meta p-accent-fg hover:underline shrink-0" disabled={state === "saving"} onClick={() => detach(promote())}
      title={failed ?? "Every workspace and agent of yours will read it alongside its own memory."}>
      {label}
    </button>
  );
}

export interface AgentSurfaceProps {
  /** Tri-state: "still coming" and "came back broken" differ, and neither is "none". */
  snapshot: AsyncResource<AgentStatus>;
  memory: MemoryEntry[];
  memoryContent: string;
  onSearchMemory: (q: string) => void;
  onRetryLoad: () => void;
  rpc: Rpc;
  /** `reads_changed` frames per live read, as WorkTab takes them. */
  readMoves?: ReadMoves;
}

export function AgentSurface(
  { snapshot, memory, memoryContent, onSearchMemory, onRetryLoad, rpc, readMoves = {} }: AgentSurfaceProps,
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
              ["Swarm nodes", String(as.searchNodeCount)],
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
              <div key={f.key} className="flex items-start gap-2 px-3 py-1.5 border-b p-border last:border-0" data-world-model-fact={f.key}>
                <span className="font-mono p-accent shrink-0">{f.key}</span>
                <span className="p-text-2 truncate flex-1 text-right">{v.is(v.string(), f.value) ? f.value : JSON.stringify(f.value)}</span>
                {f.confidence < 1 && <span className="p-meta p-text-3 shrink-0">{(f.confidence * 100).toFixed(0)}%</span>}
                {f.source !== '' && <span className="p-meta p-text-3 shrink-0">via {f.source}</span>}
                <span className="p-meta p-text-3 shrink-0">{timeAgo(f.lastObservedAt)}</span>
                {as !== null && <PromoteFact fact={f} workspace={as.name} />}
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section id="evolution" title="Evolution" defaultOpen={false}
        icon={<GitBranchIcon size={14} className="p-text-2" />}
        badge={as ? <Badge variant="secondary">v{as.scaffoldVersion}</Badge> : undefined}>
        <div className="space-y-5">
          {as && <ScaffoldLineage rpc={rpc} currentVersion={as.scaffoldVersion} />}
          <EvolutionBlock title="Self-tuning" hint="GEPA passes propose candidates for the next scaffold version.">
            <GepaView rpc={rpc} />
          </EvolutionBlock>
          <EvolutionBlock title="Quality" hint="How satisfied you were with its turns, per day, rated from your replies and thumbs.">
            <QualityView rpc={rpc} moved={readMoves.getQuality ?? 0} />
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
