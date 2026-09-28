import type { AgentCategory, PanelAgent } from "@kinu.run/core";
import { EmptyState } from "./shared";
import { UsersThreeIcon } from "@phosphor-icons/react";

const CATEGORIES: readonly { readonly category: AgentCategory; readonly title: string }[] = [
  { category: "main", title: "Main" },
  { category: "user", title: "Yours" },
  { category: "hired", title: "Hired by an agent" },
  { category: "swarm", title: "Swarm workers" },
  { category: "background", title: "Background" },
];

const ACTIVITY = {
  working: { word: "Working", dot: "p-dot-accent p-dot-pulse" },
  waiting: { word: "Needs you", dot: "bg-[var(--c-warning)]" },
  idle: { word: "Idle", dot: "bg-[var(--c-text-3)] opacity-50" },
  done: { word: "Done", dot: "bg-[var(--c-success)]" },
  failed: { word: "Failed", dot: "bg-[var(--c-danger)]" },
  dismissed: { word: "Dismissed", dot: "bg-[var(--c-text-3)] opacity-30" },
} satisfies Record<PanelAgent["activity"], { word: string; dot: string }>;

export function AgentsSurface({ panel }: {
  panel: { readonly list: readonly PanelAgent[]; readonly shown: string | null; readonly open: (agent: PanelAgent) => void } | undefined;
}) {
  const agents = panel?.list ?? [];
  const selected = panel?.shown ?? null;
  const onOpen = panel?.open ?? (() => undefined);

  const groups = CATEGORIES.map((group) => ({ ...group, agents: agents.filter((agent) => agent.category === group.category) }))
    .filter((group) => group.agents.length > 0);

  if (groups.length === 0) return <EmptyState icon={<UsersThreeIcon size={28} />} title="No agents yet" />;

  return (
    <div className="space-y-5" data-agents-panel>
      {groups.map((group) => (
        <section key={group.category} aria-label={group.title}>
          <h3 className="p-meta p-text-3 mb-1.5 uppercase tracking-wide">{group.title}</h3>
          <ul className="p-group divide-y divide-[var(--c-border)]">
            {group.agents.map((agent) => {
              const status = ACTIVITY[agent.activity];

              return (
                <li key={agent.key}>
                  <button type="button" onClick={() => onOpen(agent)} aria-current={selected === agent.key ? "true" : undefined}
                    data-agent-row={agent.key}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--c-elevated)] focus-visible:bg-[var(--c-elevated)] aria-[current=true]:bg-[var(--c-accent-subtle)]">
                    <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${status.dot}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm p-text">{agent.label}</span>
                      {agent.parent !== null && <span className="block truncate p-meta p-text-3">from {agent.parent}</span>}
                    </span>
                    <span className="shrink-0 p-meta p-text-2">{status.word}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
