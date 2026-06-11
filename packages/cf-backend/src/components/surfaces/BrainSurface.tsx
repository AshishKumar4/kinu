/**
 * Brain surface — the agent's durable self: identity, learned tools (CraftStore),
 * and long-term memory. The scaffold version-lineage + shadow-eval verdict +
 * promote/rollback (the moat) and agent_facts are layered in by the Brain phase.
 */
import { useState, useEffect } from "react";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  FingerprintIcon, PackageIcon, MagnifyingGlassIcon, DatabaseIcon, FolderOpenIcon, BrainIcon,
} from "@phosphor-icons/react";
import { ScoreBar } from "@/components/ui/score-bar";
import type { AgentStatus } from "@/hooks/use-proteus";
import type { ToolInfo, MemoryEntry, Rpc } from "@/lib/protocol";
import { MarkdownContent, EmptyState, EMPTY_HINTS } from "./shared";
import { ScaffoldLineage } from "./ScaffoldLineage";
import { EvolutionChangelog } from "./EvolutionChangelog";

interface Fact { key: string; value: unknown; confidence: number; source: string; lastObservedAt: number }

export interface BrainSurfaceProps {
  agentStatus: AgentStatus | null;
  tools: ToolInfo[];
  memory: MemoryEntry[];
  memoryContent: string;
  onSearchMemory: (q: string) => void;
  rpc: Rpc;
  /** The changelog was viewed — zero the unseen tab badge. */
  onChangelogSeen?: () => void;
}

export function BrainSurface({ agentStatus: as, tools, memory, memoryContent, onSearchMemory, rpc, onChangelogSeen }: BrainSurfaceProps) {
  const [memorySearch, setMemorySearch] = useState("");
  const [facts, setFacts] = useState<Fact[]>([]);
  useEffect(() => { rpc<Fact[]>("getFacts", [100]).then(setFacts).catch(() => {}); }, [rpc]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Identity */}
      {as ? (
        <section>
          <div className="flex items-center gap-3 mb-4">
            <div className="size-11 rounded-xl flex items-center justify-center p-elevated border p-border">
              <FingerprintIcon size={22} className="p-accent" />
            </div>
            <div>
              <div className="font-medium p-text">{as.name}</div>
              <div className="text-[11px] p-text-3 font-mono">{as.id.slice(0, 20)}…</div>
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
        </section>
      ) : <div className="flex items-center justify-center h-32"><Loader size="base" /></div>}

      {/* Evolution Changelog — what the agent changed about itself, with
          evidence + per-line keep/revert/diff. Viewing marks entries seen. */}
      <EvolutionChangelog rpc={rpc} onSeen={onChangelogSeen} />

      {/* Scaffold evolution — the moat: lineage + diff + shadow verdict + promote/rollback. */}
      {as && <ScaffoldLineage rpc={rpc} currentVersion={as.scaffoldVersion} />}

      {/* Tools (CraftStore + builtins) */}
      <section>
        <div className="flex items-center gap-2 mb-2.5">
          <PackageIcon size={14} className="p-text-2" />
          <span className="text-sm font-medium p-text">Tools</span>
          {tools.length > 0 && <Badge variant="secondary">{tools.length}</Badge>}
        </div>
        <div className="space-y-2">
          {tools.length === 0 ? (
            <EmptyState icon={<PackageIcon size={28} />} title="No tools discovered yet" hint={EMPTY_HINTS.tools} />
          ) : tools.map((tool) => {
            const isLearned = tool.scope === "global";
            return (
              <div key={tool.name} className="p-card rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <PackageIcon size={13} className="p-accent" />
                  <span className="text-sm font-medium font-mono p-text">{tool.name}</span>
                  <Badge variant={isLearned ? "primary" : "secondary"}>{isLearned ? "Learned" : "Built-in"}</Badge>
                  {tool.usageCount > 0 && <span className="text-[10px] p-text-3 ml-auto">{tool.usageCount} uses</span>}
                </div>
                <span className="text-xs p-text-2 block leading-relaxed mb-1.5">{tool.description}</span>
                {isLearned && <ScoreBar value={tool.qualityScore} className="mt-1" />}
              </div>
            );
          })}
        </div>
      </section>

      {/* Memory */}
      <section>
        <div className="flex items-center gap-2 mb-2.5">
          <DatabaseIcon size={14} className="p-text-2" />
          <span className="text-sm font-medium p-text">Memory</span>
        </div>
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
      </section>

      {/* World model — keyed agent_facts the agent remembers across turns. */}
      {facts.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2.5">
            <BrainIcon size={14} className="p-text-2" />
            <span className="text-sm font-medium p-text">World model</span>
            <Badge variant="secondary">{facts.length}</Badge>
          </div>
          <div className="rounded-md border p-border overflow-hidden text-xs">
            {facts.map((f) => (
              <div key={f.key} className="flex items-start gap-2 px-3 py-1.5 border-b p-border last:border-0">
                <span className="font-mono p-accent shrink-0">{f.key}</span>
                <span className="p-text-2 truncate flex-1 text-right">{typeof f.value === "string" ? f.value : JSON.stringify(f.value)}</span>
                {f.confidence < 1 && <span className="text-[10px] p-text-3 shrink-0">{(f.confidence * 100).toFixed(0)}%</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
