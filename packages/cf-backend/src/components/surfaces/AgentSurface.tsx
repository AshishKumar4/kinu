/**
 * Agent: who it is, what it knows, how it is doing, and how it is changing. Each answers at the density its data
 * supports: a first day says so instead of drawing empty charts.
 */
import { useCallback, useState } from "react";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  BrainIcon, ChartLineUpIcon, GitBranchIcon, GlobeHemisphereWestIcon, IdentificationCardIcon, MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import type { AgentStatus } from "@/hooks/use-chat-owner";
import type { ReadMoves } from "@/hooks/use-workspace-reads";
import type { JsonValue, MemoryEntry, Rpc } from "@kinu.run/core";
import { Effect } from "effect";
import { attempt, detach, renderThrownChain } from "@kinu.run/core/obs";
import { putAccountFact } from "../../lib/user-api";
import { MarkdownContent, Section } from "./shared";
import { timeAgo, workspaceDisplayTitle } from "@kinu.run/core";
import { ScaffoldLineage } from "./ScaffoldLineage";
import { GepaView, QualityView } from "./evolution-panels";
import { ChangelogEntryCard, ChangelogFailure, useChangelog } from "./changelog-entries";
import { ChatMascot, mascotSeed } from "@/components/Marks";
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

  if (state === "kept") return <span className="shrink-0 p-meta p-success" data-world-model-promoted>Kept for every workspace</span>;

  const promote = () => Effect.sync(() => { setState("saving"); }).pipe(
    Effect.andThen(attempt({ doing: "keeping this fact for every workspace", otherwise: "io" }, () => putAccountFact(fact.key, fact.value, workspace))),
    Effect.match({ onSuccess: () => { setState("kept"); }, onFailure: (failed) => { setState({ failed: renderThrownChain({ cause: failed }) }); } }),
  );

  const failed = typeof state === "object" ? state.failed : null;
  let label = failed === null ? "Keep for every workspace" : "Retry: keep for every workspace";

  if (state === "saving") label = "Keeping…";

  return (
    <button type="button" className="p-pill-icon shrink-0 opacity-60 transition-opacity group-hover/fact:opacity-100 focus-visible:opacity-100 disabled:opacity-40"
      disabled={state === "saving"} onClick={() => detach(promote())} aria-label={label} title={failed === null ? label : `${label}: ${failed}`}>
      <GlobeHemisphereWestIcon size={14} />
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
  /** The changelog was read: what the agent changed in itself stops counting as unseen. */
  onChangelogSeen?: (() => void) | undefined;
  rpc: Rpc;
  /** `reads_changed` frames per live read, as WorkTab takes them. */
  readMoves?: ReadMoves;
  /** The workspace's name, which the agent's mascot is drawn from. */
  workspace?: string | undefined;
}

function Chip({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return <span className={`inline-flex h-6 max-w-full items-center truncate rounded-full bg-[var(--c-neutral-tint)] px-2.5 p-meta p-text-2 ${mono ? "font-mono" : ""}`}>{children}</span>;
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="p-row-text p-text-3">{children}</p>;
}

function Who({ as, workspace }: { as: AgentStatus; workspace: string | undefined }) {
  const title = workspaceDisplayTitle({ name: as.name, displayName: as.displayName });
  const since = new Date(as.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  return (
    <Section id="agent-who" title="Who it is" icon={<IdentificationCardIcon size={14} className="p-text-2" />}>
      <div className="space-y-3">
        <div className="flex items-center gap-3.5">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border p-border p-fill">
            <ChatMascot seed={mascotSeed(workspace ?? as.name, "main")} colour={0} activity="idle" size={30} />
          </span>
          <div className="min-w-0">
            <div className="p-title truncate p-text" title={title}>{title}</div>
            <div className="truncate p-meta p-text-3" title={as.name}>Its own agent · since {since}</div>
          </div>
        </div>
        {as.purpose !== "" && <p className="p-row-text p-text-2">{as.purpose}</p>}
        <div className="flex flex-wrap gap-1.5">
          <Chip mono>{as.model}</Chip>
          <Chip>{as.messageCount} {as.messageCount === 1 ? "message" : "messages"}</Chip>
          <Chip>Prompt v{as.scaffoldVersion}</Chip>
        </div>
      </div>
    </Section>
  );
}

function Knows({ memory, memoryContent, onSearchMemory, facts, factsResource, reloadFacts, workspace }: {
  memory: MemoryEntry[];
  memoryContent: string;
  onSearchMemory: (q: string) => void;
  facts: readonly Fact[];
  factsResource: AsyncResource<Fact[]>;
  reloadFacts: () => void;
  workspace: string | null;
}) {
  const [search, setSearch] = useState("");
  const searching = search !== "";
  const notes = [...memory].reverse();
  const empty = !searching && notes.length === 0 && memoryContent === "" && facts.length === 0 && factsResource.status !== "error";

  return (
    <Section id="agent-knows" title="What it knows" icon={<BrainIcon size={14} className="p-text-2" />}
      badge={facts.length + notes.length > 0 ? <Badge variant="secondary">{facts.length + notes.length}</Badge> : undefined}>
      <div className="space-y-3">
        <label className="flex h-8 items-center gap-2 rounded-lg border p-border p-elevated px-2.5 focus-within:ring-1 focus-within:ring-[var(--c-accent)]">
          <MagnifyingGlassIcon size={13} className="shrink-0 p-text-3" aria-hidden />
          <input value={search} onChange={(event) => { setSearch(event.target.value); onSearchMemory(event.target.value); }}
            placeholder="Search what it knows" aria-label="Search what it knows"
            className="min-w-0 flex-1 bg-transparent text-sm p-text placeholder:p-text-3 focus:outline-none" />
        </label>

        {empty && <Quiet>Nothing yet. It keeps notes and facts as it works, and you can ask it to remember something.</Quiet>}

        {searching && notes.length === 0 && <Quiet>Nothing it knows matches.</Quiet>}

        {notes.length > 0 && (
          <div className="space-y-1.5">
            <p className="p-meta p-text-3">{searching ? "Notes that match" : "Notes"}</p>
            <div data-learnings className="p-group">
              {notes.map((entry, index) => (
                <div key={index} data-learning className="px-3 py-2.5">
                  <p className="line-clamp-2 p-row-text p-text">{entry.content.split("\n")[0]}</p>
                  <p className="mt-0.5 p-meta p-text-4">{entry.updatedAt}{entry.savedBy ? ` · ${entry.savedBy}` : ""}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {!searching && memoryContent !== "" && (
          <details className="group/memory">
            <summary className="cursor-pointer p-meta p-text-3 hover:p-text">The whole memory file</summary>
            <div className="mt-2 max-h-[420px] overflow-y-auto p-card px-4 py-3 prose-chat p-text"><MarkdownContent content={memoryContent} /></div>
          </details>
        )}

        {factsResource.status === "error" && <LoadFailure what="what it has noticed" message={factsResource.message} onRetry={reloadFacts} />}

        {!searching && facts.length > 0 && (
          <div className="space-y-1.5">
            <p className="p-meta p-text-3">Noticed between turns</p>
            <div className="p-group">
              {facts.map((fact) => (
                <div key={fact.key} className="group/fact flex items-start gap-3 px-3 py-2.5" data-world-model-fact={fact.key}>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 p-row-text p-text">{v.is(v.string(), fact.value) ? fact.value : JSON.stringify(fact.value)}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 p-meta p-text-4">
                      <span className="font-mono">{fact.key}</span>
                      {fact.confidence < 1 && <span className="tabular-nums">{(fact.confidence * 100).toFixed(0)}% sure</span>}
                      {fact.source !== "" && <span>from {fact.source}</span>}
                      <span>{timeAgo(fact.lastObservedAt)}</span>
                    </p>
                  </div>
                  {workspace !== null && <PromoteFact fact={fact} workspace={workspace} />}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

function Changing({ rpc, readMoves, onChangelogSeen, version }: {
  rpc: Rpc; readMoves: ReadMoves; onChangelogSeen: (() => void) | undefined; version: number | null;
}) {
  const { view, seenAt, seenError, resource, reload } = useChangelog(rpc, onChangelogSeen, readMoves.getEvolutionChangelog ?? 0);
  const entries = view?.entries ?? [];

  return (
    <Section id="evolution" title="How it's changing" icon={<GitBranchIcon size={14} className="p-text-2" />}
      badge={version === null ? undefined : <Badge variant="secondary">v{version}</Badge>}>
      <div className="space-y-5">
        {(view === null || resource.status === "error") && <ChangelogFailure resource={resource} reload={reload} />}
        {seenError !== null && <p className="p-meta p-warning">Could not mark these as seen: {seenError}</p>}
        {view !== null && entries.length === 0 && (
          <Quiet>No changes yet. As it works it can refine its prompt, make tools and learn facts. Each change shows here, and most can be undone.</Quiet>
        )}
        {entries.length > 0 && (
          <div className="p-group" data-changelog>
            {entries.map((entry) => <ChangelogEntryCard key={entry.id} grouped entry={entry} seenAt={seenAt} rpc={rpc} onReverted={reload} />)}
          </div>
        )}
        {version !== null && (
          <section className="space-y-1.5">
            <p className="p-eyebrow">Prompt versions</p>
            <ScaffoldLineage rpc={rpc} currentVersion={version} />
          </section>
        )}
        <section className="space-y-1.5">
          <p className="p-eyebrow">Self-tuning</p>
          <p className="p-meta p-text-3">Passes that try candidate prompts against its past turns, and keep a better one.</p>
          <GepaView rpc={rpc} />
        </section>
      </div>
    </Section>
  );
}

export function AgentSurface(
  { snapshot, memory, memoryContent, onSearchMemory, onRetryLoad, onChangelogSeen, rpc, readMoves = {}, workspace }: AgentSurfaceProps,
) {
  // "Nothing noticed" may only be claimed about a listing that came back.
  const loadFacts = useCallback(() => rpc<Fact[]>("getFacts", [100]), [rpc]);
  const { resource: factsResource, reload: reloadFacts } = useAsyncResource(loadFacts);
  const facts = lastValue(factsResource) ?? [];
  const as = lastValue(snapshot);

  return (
    <div className="space-y-6 animate-fade-in">
      {as === null && snapshot.status === "error" && <LoadFailure what="this agent" onRetry={onRetryLoad} />}
      {as === null && snapshot.status !== "error" && <div className="flex h-32 items-center justify-center"><Loader size="base" /></div>}
      {as !== null && <Who as={as} workspace={workspace} />}
      <Knows memory={memory} memoryContent={memoryContent} onSearchMemory={onSearchMemory} facts={facts} factsResource={factsResource}
        reloadFacts={reloadFacts} workspace={as?.name ?? null} />
      <Section id="agent-doing" title="How it's doing" icon={<ChartLineUpIcon size={14} className="p-text-2" />}>
        <QualityView rpc={rpc} moved={readMoves.getQuality ?? 0} />
      </Section>
      <Changing rpc={rpc} readMoves={readMoves} onChangelogSeen={onChangelogSeen} version={as?.scaffoldVersion ?? null} />
    </div>
  );
}
