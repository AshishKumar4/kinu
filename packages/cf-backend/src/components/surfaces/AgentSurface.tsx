/**
 * Agent: who it is, what it knows, how it is doing, and how it is changing. Each answers at the density its data
 * supports: a first day says so instead of drawing empty charts.
 */
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Loader } from "@/components/ui/Loader";
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
import { ChatMascot } from "@/components/ui/Marks";
import { useMascotOf } from "@/hooks/use-chat-mascot";
import { MAIL_ROW, mailTime } from "@/components/mail/ImportantMailRow";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import * as v from "valibot";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import type { OrchestratorAgent } from "@/orchestrator";
import { Group } from "@/components/ui/Group";
import { IconControl } from "@/components/ui/IconControl";
import { Chip } from "@/components/ui/Chip";
import { Surface } from "@/components/ui/Surface";
import { PressableLink } from "@/components/ui/Pressable";
import { TextInput } from "@/components/ui/Field";

type Fact = Awaited<ReturnType<OrchestratorAgent["getFacts"]>>[number];

type PromoteState = "idle" | "saving" | "kept" | { readonly failed: string };

/**
 * This workspace's fact, kept for every workspace and agent of the account: the owner's own promotion, so it is kept at
 * once, with this workspace named as where it came from (Settings → Memory shows it).
 */
function PromoteFact({ fact, workspace }: { fact: Fact; workspace: string }) {
  const [state, setState] = useState<PromoteState>("idle");

  if (state === "kept") return <span className="t-meta shrink-0 p-success" data-world-model-promoted>Kept for every workspace</span>;

  const promote = () => Effect.sync(() => { setState("saving"); }).pipe(
    Effect.andThen(attempt({ doing: "keeping this fact for every workspace", otherwise: "io" }, () => putAccountFact(fact.key, fact.value, workspace))),
    Effect.match({ onSuccess: () => { setState("kept"); }, onFailure: (failed) => { setState({ failed: renderThrownChain({ cause: failed }) }); } }),
  );

  const failed = typeof state === "object" ? state.failed : null;
  let label = failed === null ? "Keep for every workspace" : "Retry: keep for every workspace";

  if (state === "saving") label = "Keeping…";

  return (
    <IconControl place="pill" className="shrink-0 opacity-60 transition-opacity group-hover/fact:opacity-100 focus-visible:opacity-100 disabled:opacity-40" disabled={state === "saving"} onClick={() => detach(promote())} aria-label={label} title={failed === null ? label : `${label}: ${failed}`}>
      <GlobeHemisphereWestIcon size={14} />
    </IconControl>
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

function Label({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return <Chip><span className={`truncate${mono ? " t-mono" : ""}`}>{children}</span></Chip>;
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="t-body p-text-3">{children}</p>;
}

function Who({ as, workspace, address }: { as: AgentStatus; workspace: string | undefined; address: string | null }) {
  const look = useMascotOf(workspace ?? as.name)("main", 0);
  const title = workspaceDisplayTitle({ name: as.name, displayName: as.displayName });
  const since = new Date(as.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  return (
    <Section id="agent-who" title="Profile" icon={<IdentificationCardIcon size={14} className="p-text-2" />}>
      <div className="space-y-3">
        <div className="flex items-center gap-4">
          <Surface look="tile" as="span" className="flex size-12 shrink-0 items-center justify-center border p-border">
            <ChatMascot seed={look.seed} colour={look.colour} activity="idle" size={30} />
          </Surface>
          <div className="min-w-0">
            <div className="t-title truncate p-text" title={title}>{title}</div>
            {address !== null && <div className="t-meta t-mono truncate p-text-2" data-agent-address>{address}</div>}
            <div className="t-meta truncate p-text-3" title={as.name}>Since {since}</div>
          </div>
        </div>
        {as.purpose !== "" && <p className="t-body p-text-2">{as.purpose}</p>}
        <div className="flex flex-wrap gap-2">
          <Label mono>{as.model}</Label>
          <Label>{as.messageCount} {as.messageCount === 1 ? "message" : "messages"}</Label>
          <Label>Prompt v{as.scaffoldVersion}</Label>
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
      badge={mail.unread > 0 ? <Badge>{mail.unread}</Badge> : undefined}>
      <Group>
        {mail.threads.map((thread) => (
          <PressableLink look="flush" key={thread.id} to={`/mail/${encodeURIComponent(thread.id)}`} className={MAIL_ROW} data-agent-mail-thread={thread.id}>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className={`t-body min-w-0 flex-1 truncate ${thread.unread ? "t-label p-text" : "p-text-2"}`}>
                {thread.from.map((party) => party.name ?? party.address).join(", ")}
              </span>
              <span className="t-meta shrink-0 tabular-nums p-text-3">{mailTime(thread.at)}</span>
            </span>
            <span className={`t-body block truncate ${thread.unread ? "p-text" : "p-text-2"}`}>{thread.subject}</span>
            <span className="t-meta block truncate p-text-3">{thread.verified ? thread.snippet : `Not verified · ${thread.snippet}`}</span>
          </PressableLink>
        ))}
      </Group>
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
      badge={facts.length + notes.length > 0 ? <Badge>{facts.length + notes.length}</Badge> : undefined}>
      <div className="space-y-3">
        <TextInput value={search} onChange={(event) => { setSearch(event.target.value); onSearchMemory(event.target.value); }}
          placeholder="Search memory" aria-label="Search memory" before={<MagnifyingGlassIcon size={13} className="block" aria-hidden />} />

        {/* The page's notice gives the reason once; this offers the retry. */}
        {read.state === "failed" && <LoadFailure what="memory" onRetry={read.retry} />}
        {read.state === "loading" && <div className="flex h-16 items-center justify-center"><Loader size="sm" /></div>}
        {empty && <p data-empty className="t-body p-text-3">No notes yet.</p>}

        {searching && notes.length === 0 && <Quiet>No matches.</Quiet>}

        {notes.length > 0 && (
          <div className="space-y-2">
            <p className="t-meta p-text-3">{searching ? "Notes that match" : "Notes"}</p>
            <Group data-learnings="">
              {notes.map((entry, index) => (
                <div key={index} data-learning className="px-3 py-2">
                  <p className="t-body line-clamp-2 p-text">{entry.content.split("\n")[0]}</p>
                  <p className="t-meta mt-px p-text-3">{entry.updatedAt}{entry.savedBy ? ` · ${entry.savedBy}` : ""}</p>
                </div>
              ))}
            </Group>
          </div>
        )}

        {!searching && memoryContent !== "" && (
          <details className="group/memory">
            <summary className="t-meta cursor-pointer p-text-3 hover:p-text">Memory file</summary>
            <Surface look="panel" data-memory-file className="mt-2 max-h-105 overflow-y-auto px-4 py-3 prose-chat p-text"><MarkdownContent content={memoryContent} /></Surface>
          </details>
        )}

        {factsResource.status === "error" && <LoadFailure what="facts" message={factsResource.message} onRetry={reloadFacts} />}

        {!searching && facts.length > 0 && (
          <div className="space-y-2">
            <p className="t-meta p-text-3">Facts</p>
            <Group>
              {facts.map((fact) => (
                <div key={fact.key} className="group/fact flex items-start gap-3 px-3 py-2" data-world-model-fact={fact.key}>
                  <div className="min-w-0 flex-1">
                    <p className="t-body line-clamp-2 p-text">{v.is(v.string(), fact.value) ? fact.value : JSON.stringify(fact.value)}</p>
                    <p className="t-meta mt-px flex flex-wrap items-center gap-x-2 p-text-3">
                      <span className="font-mono">{fact.key}</span>
                      {fact.confidence < 1 && <span className="tabular-nums">{(fact.confidence * 100).toFixed(0)}% sure</span>}
                      {fact.source !== "" && <span>from {fact.source}</span>}
                      <span>{timeAgo(fact.lastObservedAt)}</span>
                    </p>
                  </div>
                  {workspace !== null && <PromoteFact fact={fact} workspace={workspace} />}
                </div>
              ))}
            </Group>
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
      badge={version === null ? undefined : <Badge>v{version}</Badge>}>
      <div className="space-y-5">
        {(view === null || resource.status === "error") && <ChangelogFailure resource={resource} reload={reload} />}
        {seenError !== null && <p className="t-meta p-warning">Could not mark these as seen: {seenError}</p>}
        {view !== null && entries.length === 0 && (
          <Quiet>No changes yet.</Quiet>
        )}
        {entries.length > 0 && (
          <Group data-changelog="">
            {entries.map((entry) => <ChangelogEntryCard key={entry.id} grouped entry={entry} seenAt={seenAt} rpc={rpc} onReverted={reload} />)}
          </Group>
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
