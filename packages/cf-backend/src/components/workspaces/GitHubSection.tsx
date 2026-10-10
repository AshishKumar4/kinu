import { useCallback, useEffect, useRef } from "react";
import { GitBranchIcon, GitMergeIcon, GitPullRequestIcon, CircleDashedIcon, CheckCircleIcon, XCircleIcon, RecordIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { shortAge, type PanelAgent, type Rpc, type WorkspaceGitHubView } from "@kinu.run/core";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import type { ReadMoves } from "@/hooks/use-workspace-reads";

type Repo = WorkspaceGitHubView["repos"][number];

type Item = WorkspaceGitHubView["items"][number];

const CI = {
  success: { Icon: CheckCircleIcon, word: "passing", tone: "p-success" },
  failure: { Icon: XCircleIcon, word: "failing", tone: "p-danger" },
  pending: { Icon: CircleDashedIcon, word: "running", tone: "p-text-3" },
} as const;

const STATE_TONE = new Map([["open", "p-success"], ["merged", "p-accent"], ["closed", "p-text-3"]]);

export function GitHubSection({ rpc, readMoves, agents }: { rpc: Rpc; readMoves: ReadMoves; agents: readonly PanelAgent[] }) {
  const asked = useRef(false);

  const load = useCallback(() => {
    const refresh = !asked.current;
    asked.current = true;

    return rpc<WorkspaceGitHubView>("getWorkspaceGitHub", [refresh]);
  }, [rpc]);

  const { resource, reload } = useAsyncResource(load);
  const github = lastValue(resource);
  const moves = readMoves.getWorkspaceGitHub ?? 0;
  const seen = useRef(moves);

  useEffect(() => {
    if (seen.current === moves) return;
    seen.current = moves;
    reload();
  }, [moves, reload]);

  if (resource.status === "error" && github === null) return <LoadFailure what="this workspace's GitHub work" message={resource.message} onRetry={reload} />;

  const nameOf = (actorId: string) => agents.find((agent) => agent.actorId === actorId)?.label ?? "an agent";

  return (
    <div className="flex flex-col gap-2" data-overview-github>
      <div className="grid gap-3 md:grid-cols-2">
        <Panel icon={<GitBranchIcon size={15} />} title="Repositories" count={github?.repos.length}>
          {github !== null && (github.repos.length === 0
            ? <Empty text="None yet. The workspace's GitHub remotes show here, with what its agents push." />
            : github.repos.map((repo) => <RepoRow key={repo.repo} repo={repo} />))}
        </Panel>
        <Panel icon={<GitPullRequestIcon size={15} />} title="Issues and pull requests" count={github?.items.length}>
          {github !== null && (github.items.length === 0
            ? <Empty text="None yet. The issues and pull requests the agents open or work on show here." />
            : github.items.map((item) => <ItemRow key={`${item.repo}#${String(item.number)}`} item={item} nameOf={nameOf} />))}
        </Panel>
      </div>
      {github !== null && <p className="p-meta p-text-4" data-github-checked={github.refresh}>{checkedLine(github)}</p>}
    </div>
  );
}

function checkedLine(github: WorkspaceGitHubView): string {
  if (github.refresh === "no-token") return "Not checked with GitHub: connect GitHub in Plugins to see live state.";

  if (github.observedAt === null) return "Not checked with GitHub yet.";

  return `Checked with GitHub ${shortAge(github.observedAt)} ago.`;
}

function Panel({ icon, title, count, children }: { icon: ReactNode; title: string; count: number | undefined; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-xl border p-border">
      <header className="flex items-center gap-2 px-4 pb-2 pt-3">
        <span className="p-text-3">{icon}</span>
        <span className="text-[13.5px] font-medium p-text-2">{title}</span>
        {count !== undefined && count > 0 && <span className="ml-auto p-meta tabular-nums p-text-4">{count}</span>}
      </header>
      <ul className="flex flex-col pb-1.5">{children}</ul>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <li className="px-4 pb-2.5 text-[12.5px] leading-[18px] p-text-3">{text}</li>;
}

function RepoRow({ repo }: { repo: Repo }) {
  const ci = repo.ci === null || repo.ci.state === "none" ? null : CI[repo.ci.state];

  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-1.5" data-github-repo={repo.repo}>
      <a href={`https://github.com/${repo.repo}`} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-[13px] p-text hover:underline">{repo.repo}</a>
      {repo.branch && <span className="min-w-0 truncate font-mono text-[11.5px] p-text-3">{repo.branch}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-2.5 p-meta p-text-3">
        {repo.lastPush && <span title={repo.lastPush.ref}>pushed {shortAge(repo.lastPush.at)} ago</span>}
        {ci && <span className={`inline-flex items-center gap-1 ${ci.tone}`}><ci.Icon size={12} weight="fill" aria-hidden />{ci.word}</span>}
      </span>
    </li>
  );
}

function ItemRow({ item, nameOf }: { item: Item; nameOf: (actorId: string) => string }) {
  const merged = item.subject === "pr" && item.state === "merged";
  const Icon = item.subject === "pr" ? GitPullRequestIcon : RecordIcon;
  const who = [...new Set([...item.actors.map(nameOf), ...(item.unattributed ? ["an agent"] : [])])].join(", ");

  return (
    <li className="flex min-w-0 items-center gap-2.5 px-4 py-1.5" data-github-item={`${item.repo}#${String(item.number)}`}>
      {merged
        ? <GitMergeIcon size={14} className="shrink-0 p-accent" aria-label="merged" />
        : <Icon size={14} className={`shrink-0 ${STATE_TONE.get(item.state ?? "") ?? "p-text-3"}`} aria-label={item.state ?? "state unknown"} />}
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-[13px] p-text hover:underline">
        {item.title ?? `${item.repo}#${String(item.number)}`}
      </a>
      <span className="ml-auto shrink-0 p-meta p-text-4">{`#${String(item.number)}`}{who && ` · ${who}`}</span>
    </li>
  );
}
