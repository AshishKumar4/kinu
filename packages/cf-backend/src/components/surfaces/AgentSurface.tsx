/**
 * Agent: who it is, what it knows, how it is doing, and how it is changing. Each answers at the density its data
 * supports: a first day says so instead of drawing empty charts.
 */
import { useCallback, useState } from "react";
import { Badge, Loader } from "@cloudflare/kumo";
import {
  BrainIcon, ChartLineUpIcon, EnvelopeSimpleIcon, GitBranchIcon, GlobeHemisphereWestIcon, IdentificationCardIcon, MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import type { AgentStatus } from "@kinu.run/core";
import type { ReadMoves } from "@/hooks/use-workspace-reads";
import type { MemoryEntry } from "@kinu.run/core";
import { Effect } from "effect";
import { attempt, detach, renderThrownChain } from "@kinu.run/core/obs";
import { putAccountFact } from "../../lib/user-api";
import { MarkdownContent, Section } from "./shared";
import { timeAgo, workspaceDisplayTitle } from "@kinu.run/core";
import { ScaffoldLineage } from "./ScaffoldLineage";
import { QualityView } from "./evolution-panels";
import { ChangelogEntryCard, ChangelogFailure, useChangelog } from "./changelog-entries";
import { ChatMascot } from "@/components/Marks";
import { useMascotOf } from "@/hooks/use-chat-mascot";
import { mailRowCls, mailTime } from "@/components/mail/ImportantMailRow";
import { Link } from "react-router-dom";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import * as v from "valibot";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import type { OrchestratorAgent } from "@/orchestrator";

type Fact = Awaited<ReturnType<OrchestratorAgent["getFacts"]>>[number];

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
  rpc: WorkspaceRpc;
  /** `reads_changed` frames per live read, as WorkTab takes them. */
  readMoves?: ReadMoves;
  /** The workspace's name, which the agent's mascot is drawn from. */
  workspace?: string | undefined;
  /** The agent the tab is about, by actor id; absent, the workspace's main agent. */
  actorId?: string | undefined;
}

type AgentMail = NonNullable<Awaited<ReturnType<OrchestratorAgent["agentMail"]>>>;

function Chip({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return <span className={`inline-flex h-6 max-w-full items-center truncate rounded-full bg-[var(--c-hover)] px-2.5 p-meta p-text-2 ${mono ? "font-mono" : ""}`}>{children}</span>;
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="p-row-text p-text-3">{children}</p>;
}

function Who({ as, workspace, address }: { as: AgentStatus; workspace: string | undefined; address: string | null }) {
  const look = useMascotOf(workspace ?? as.name)("main", 0);
  const title = workspaceDisplayTitle({ name: as.name, displayName: as.displayName });
  const since = new Date(as.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  return (
    <Section id="agent-who" title="Profile" icon={<IdentificationCardIcon size={14} className="p-text-2" />}>
      <div className="space-y-3">
        <div className="flex items-center gap-3.5">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border p-border p-fill">
            <ChatMascot seed={look.seed} colour={look.colour} activity="idle" size={30} />
          </span>
          <div className="min-w-0">
            <div className="p-title truncate p-text" title={title}>{title}</div>
            {address !== null && <div className="truncate font-mono p-meta p-text-2" data-agent-address>{address}</div>}
            <div className="truncate p-meta p-text-3" title={as.name}>Since {since}</div>
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

/** The agent's own mail, shown only while it has any (docs/MAIL.md §7); each thread opens in Mail. */
function Mail({ mail }: { mail: AgentMail }) {
  if (mail.threads.length === 0) return null;

  return (
    <Section id="agent-mail" title="Mail" icon={<EnvelopeSimpleIcon size={14} className="p-text-2" />}
      badge={mail.unread > 0 ? <Badge variant="secondary">{mail.unread}</Badge> : undefined}>
      <div className="p-group">
        {mail.threads.map((thread) => (
          <Link key={thread.id} to={`/mail/${encodeURIComponent(thread.id)}`} className={mailRowCls(false)} data-agent-mail-thread={thread.id}>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={`min-w-0 flex-1 truncate p-row-text ${thread.unread ? "font-semibold p-text" : "p-text-2"}`}>
                {thread.from.map((party) => party.name ?? party.address).join(", ")}
              </span>
              <span className="shrink-0 p-meta tabular-nums p-text-3">{mailTime(thread.at)}</span>
            </span>
            <span className={`block truncate p-row-text ${thread.unread ? "p-text" : "p-text-2"}`}>{thread.subject}</span>
            <span className="block truncate p-meta p-text-3">{thread.verified ? thread.snippet : `Not verified · ${thread.snippet}`}</span>
          </Link>
        ))}
      </div>
    </Section>
  );
}

/** Whether the workspace's read has come back: "nothing it knows" may only be said of one that did. */
type Read = { readonly state: "loading" } | { readonly state: "failed"; readonly retry: () => void } | { readonly state: "loaded" };

function Knows({ read, memory, memoryContent, onSearchMemory, facts, factsResource, reloadFacts, workspace }: {
  read: Read;
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

  const empty = read.state === "loaded" && !searching && notes.length === 0 && memoryContent === "" && facts.length === 0
    && factsResource.status !== "error";

  return (
    <Section id="memory" title="Memory" icon={<BrainIcon size={14} className="p-text-2" />}
      badge={facts.length + notes.length > 0 ? <Badge variant="secondary">{facts.length + notes.length}</Badge> : undefined}>
      <div className="space-y-3">
        <label className="flex h-8 items-center gap-2 rounded-lg border p-border p-fill px-2.5 focus-within:ring-1 focus-within:ring-[var(--c-accent)]">
          <MagnifyingGlassIcon size={13} className="shrink-0 p-text-3" aria-hidden />
          <input value={search} onChange={(event) => { setSearch(event.target.value); onSearchMemory(event.target.value); }}
            placeholder="Search memory" aria-label="Search memory"
            className="min-w-0 flex-1 bg-transparent text-sm p-text placeholder:p-text-3 focus:outline-none" />
        </label>

        {/* The page's notice gives the reason once; this offers the retry. */}
        {read.state === "failed" && <LoadFailure what="memory" onRetry={read.retry} />}
        {read.state === "loading" && <div className="flex h-16 items-center justify-center"><Loader size="sm" /></div>}
        {empty && <p data-empty className="p-row-text p-text-3">No notes yet.</p>}

        {searching && notes.length === 0 && <Quiet>No matches.</Quiet>}

        {notes.length > 0 && (
          <div className="space-y-1.5">
            <p className="p-meta p-text-3">{searching ? "Notes that match" : "Notes"}</p>
            <div data-learnings className="p-group">
              {notes.map((entry, index) => (
                <div key={index} data-learning className="px-3 py-2.5">
                  <p className="line-clamp-2 p-row-text p-text">{entry.content.split("\n")[0]}</p>
                  <p className="mt-0.5 p-meta p-text-3">{entry.updatedAt}{entry.savedBy ? ` · ${entry.savedBy}` : ""}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {!searching && memoryContent !== "" && (
          <details className="group/memory">
            <summary className="cursor-pointer p-meta p-text-3 hover:p-text">Memory file</summary>
            <div data-memory-file className="mt-2 max-h-[420px] overflow-y-auto p-card px-4 py-3 prose-chat p-text"><MarkdownContent content={memoryContent} /></div>
          </details>
        )}

        {factsResource.status === "error" && <LoadFailure what="facts" message={factsResource.message} onRetry={reloadFacts} />}

        {!searching && facts.length > 0 && (
          <div className="space-y-1.5">
            <p className="p-meta p-text-3">Facts</p>
            <div className="p-group">
              {facts.map((fact) => (
                <div key={fact.key} className="group/fact flex items-start gap-3 px-3 py-2.5" data-world-model-fact={fact.key}>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 p-row-text p-text">{v.is(v.string(), fact.value) ? fact.value : JSON.stringify(fact.value)}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 p-meta p-text-3">
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

function readOf(loaded: boolean, failed: boolean, retry: () => void): Read {
  if (loaded) return { state: "loaded" };

  return failed ? { state: "failed", retry } : { state: "loading" };
}

function Changing({ rpc, readMoves, version }: {
  rpc: WorkspaceRpc; readMoves: ReadMoves; version: number | null;
}) {
  const { view, seenAt, seenError, resource, reload } = useChangelog(rpc, readMoves.getEvolutionChangelog ?? 0);
  const entries = view?.entries ?? [];

  return (
    <Section id="evolution" title="Evolution" icon={<GitBranchIcon size={14} className="p-text-2" />}
      badge={version === null ? undefined : <Badge variant="secondary">v{version}</Badge>}>
      <div className="space-y-5">
        {(view === null || resource.status === "error") && <ChangelogFailure resource={resource} reload={reload} />}
        {seenError !== null && <p className="p-meta p-warning">Could not mark these as seen: {seenError}</p>}
        {view !== null && entries.length === 0 && (
          <Quiet>No changes yet.</Quiet>
        )}
        {entries.length > 0 && (
          <div className="p-group" data-changelog>
            {entries.map((entry) => <ChangelogEntryCard key={entry.id} grouped entry={entry} seenAt={seenAt} rpc={rpc} onReverted={reload} />)}
          </div>
        )}
        {version !== null && <ScaffoldLineage rpc={rpc} currentVersion={version} />}
      </div>
    </Section>
  );
}

export function AgentSurface(
  { snapshot, memory, memoryContent, onSearchMemory, onRetryLoad, rpc, readMoves = {}, workspace, actorId }: AgentSurfaceProps,
) {
  const loadMail = useCallback(() => rpc("agentMail", [actorId]), [rpc, actorId]);
  const mail = lastValue(useAsyncResource(loadMail).resource) ?? null;
  // "Nothing noticed" may only be claimed about a listing that came back.
  const loadFacts = useCallback(() => rpc("getFacts", [100]), [rpc]);
  const { resource: factsResource, reload: reloadFacts } = useAsyncResource(loadFacts);
  const facts = lastValue(factsResource) ?? [];
  const as = lastValue(snapshot);

  return (
    <div className="space-y-6 animate-fade-in">
      {as !== null && <Who as={as} workspace={workspace} address={mail?.address ?? null} />}
      {mail !== null && <Mail mail={mail} />}
      <Knows read={readOf(as !== null, snapshot.status === "error", onRetryLoad)} memory={memory} memoryContent={memoryContent}
        onSearchMemory={onSearchMemory} facts={facts} factsResource={factsResource} reloadFacts={reloadFacts} workspace={as?.name ?? null} />
      <Section id="agent-doing" title="Activity" icon={<ChartLineUpIcon size={14} className="p-text-2" />}>
        <QualityView rpc={rpc} moved={readMoves.getQuality ?? 0} />
      </Section>
      <Changing rpc={rpc} readMoves={readMoves} version={as?.scaffoldVersion ?? null} />
    </div>
  );
}
