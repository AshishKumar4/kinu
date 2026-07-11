import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRightIcon,
  BrainIcon,
  GearSixIcon,
  KeyIcon,
  PlusIcon,
  TerminalIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import { useCreateAgent } from "@/hooks/use-create-agent";
import { listWorkspaces, type WorkspaceEntry } from "@/lib/user-api";

export default function HomePage() {
  const [mission, setMission] = useState("");
  const [agents, setAgents] = useState<WorkspaceEntry[]>([]);
  const { hasModels, busy, err, create } = useCreateAgent();

  useEffect(() => {
    listWorkspaces().then(setAgents).catch(() => setAgents([]));
  }, []);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    void create(mission);
  };

  return (
    <div className="h-full overflow-y-auto p-bg">
      <main className="mx-auto grid min-h-full w-full max-w-5xl grid-cols-[minmax(0,1fr)] content-center gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_280px] lg:py-12">
        <section className="min-w-0">
          <div className="mb-7 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border p-border p-elevated">
              <BrainIcon size={23} weight="duotone" className="p-accent" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.18em] p-accent">Proteus</p>
              <h1 className="mt-1 text-3xl font-semibold leading-tight tracking-normal p-text sm:text-4xl">
                Start with a mission.
              </h1>
            </div>
          </div>

          <form
            onSubmit={submit}
            className="mt-8 rounded-lg border p-border p-elevated p-3 shadow-[0_18px_70px_rgba(0,0,0,0.18)] sm:p-4"
          >
            <textarea
              value={mission}
              onChange={(event) => setMission(event.currentTarget.value)}
              placeholder="Ask Proteus to investigate a bug, build a feature, audit the app, automate a workflow, or improve its own UI."
              rows={6}
              className="block min-h-36 w-full resize-y rounded-md border p-border p-bg px-3 py-3 text-sm leading-7 p-text outline-none placeholder:p-text-3 transition-all focus:border-[var(--c-accent)] focus:ring-2 focus:ring-[var(--c-accent-subtle)]"
            />

            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs p-text-3">Proteus will create the agent, seed SOUL.md, and send this as the first turn.</p>

              <button
                type="submit"
                disabled={busy || !mission.trim() || hasModels === false}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium text-white transition-opacity disabled:opacity-40"
                style={{ background: "var(--c-accent)" }}
              >
                {busy ? <Loader size="sm" /> : <PlusIcon size={15} />}
                Create agent
              </button>
            </div>
          </form>

          {hasModels === false && (
            <div className="mt-3">
              <CloudflareAIConnectNotice
                returnTo="/"
                message="Connect Cloudflare Workers AI before creating an agent."
              />
            </div>
          )}

          {err && (
            <div className="mt-3 rounded-md border border-red-400/40 px-3 py-2 text-xs text-red-400" style={{ background: "rgba(248,113,113,0.08)" }}>
              {err}
            </div>
          )}
        </section>

        <aside className="space-y-5 lg:pt-[5.25rem]">
          <div className="rounded-lg border p-border p-card p-4">
            <div className="flex items-center gap-2">
              <GearSixIcon size={16} className="p-accent" />
              <span className="text-sm font-semibold p-text">Setup</span>
            </div>
            <div className="mt-3 space-y-1">
              <QuickLink to="/user/settings" icon={<KeyIcon size={14} />} label="Model providers" />
              <QuickLink to="/install" icon={<TerminalIcon size={14} />} label="Install CLI" external />
            </div>
          </div>

          {agents.length > 0 && (
            <div className="rounded-lg border p-border p-card p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold p-text">Recent</span>
                <span className="text-xs p-text-3">{agents.length}</span>
              </div>
              <div className="mt-3 space-y-1">
                {agents.slice(0, 5).map((agent) => (
                  <Link
                    key={agent.name}
                    to={`/agent/${agent.name}`}
                    className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm p-text-2 transition-colors hover:p-card-hover hover:p-text"
                  >
                    <WrenchIcon size={13} className="shrink-0 p-text-3" />
                    <span className="truncate">{agent.displayName || agent.name}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

function QuickLink({
  to,
  icon,
  label,
  external = false,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  external?: boolean;
}) {
  const className = "flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm p-text-2 transition-colors hover:p-card-hover hover:p-text";
  const content = (
    <>
      <span className="inline-flex items-center gap-2">
        <span className="p-accent">{icon}</span>
        {label}
      </span>
      <ArrowRightIcon size={13} className="p-text-3" />
    </>
  );
  return external ? <a href={to} className={className}>{content}</a> : <Link to={to} className={className}>{content}</Link>;
}
