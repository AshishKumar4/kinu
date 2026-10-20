/**
 * A workspace blueprint's page on Explore: what it does, what a new workspace from it holds (its agents, its schedules
 * and watches, its slates, its layout and soul), what it needs of yours and what it asks you before acting; and Install.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Effect } from "effect";
import { Loader } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, CaretRightIcon, ClockIcon, HandPalmIcon, KeyIcon, LayoutIcon, RobotIcon, StarIcon, AppWindowIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { mcpPresetById } from "@kinu.run/core";
import { detach, showing } from "@kinu.run/core/obs";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Status } from "@/components/ui/Status";
import { BrandMark } from "@/components/ui/BrandMark";
import { presetBrand } from "@/components/plugins/McpPresetCards";
import { FilledButton } from "@/components/ui/FilledButton";
import { CATEGORY_WORDS } from "@/components/sharing/words";
import { KindBadge, Maker, blueprintPicturePath } from "@/components/explore/ExploreCard";
import { InstallDialog } from "@/components/explore/InstallDialog";
import { useMcpServers } from "@/hooks/use-mcp-servers";
import { lastValue } from "@/hooks/use-async-resource";
import { readBlueprint, type BlueprintPage, type ExploreNeed } from "@/lib/explore-api";
import { pictureSrc } from "@/lib/picture-src";

const ago = (at: number) => {
  const days = Math.round((Date.now() - at) / 864e5);

  return days <= 0 ? "today" : `${String(days)} day${days === 1 ? "" : "s"} ago`;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="p-eyebrow">{title}</h2>
      {children}
    </section>
  );
}

function Row({ icon, title, meta, children }: { icon: ReactNode; title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--c-neutral-tint)] p-text-2">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="p-row-text font-medium p-text">{title}</span>
          {meta !== undefined && <span className="p-meta p-text-3">{meta}</span>}
        </span>
        {children !== undefined && <span className="block p-meta p-text-2">{children}</span>}
      </span>
    </li>
  );
}


/** A need, and whether you already have it: a connection is yours once its server is connected in Plugins. */
function NeedRow({ need, connected }: { need: ExploreNeed; connected: boolean }) {
  const brand = presetBrand(need.connection);
  const name = need.connection === null ? (need.secret ?? "A secret") : (mcpPresetById(need.connection)?.title ?? need.connection);

  return (
    <li className="flex items-start gap-3 px-4 py-3" data-blueprint-need={need.connection ?? need.secret}>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--c-neutral-tint)]">
        {brand !== undefined ? <BrandMark brand={brand} size={14} bare /> : <KeyIcon size={14} className="p-text-2" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2">
          <span className="p-row-text font-medium p-text">{name}</span>
          <span className="p-meta p-text-3">{need.access === "read" ? "to read" : "to read and write"}</span>
        </span>
        <span className="block p-meta p-text-2">{need.why}</span>
      </span>
      {connected ? <Status tone="success">Connected</Status> : <span className="shrink-0 p-meta p-text-3">At install</span>}
    </li>
  );
}

export default function ExploreWorkspacePage() {
  const { blueprint = "" } = useParams();
  const [page, setPage] = useState<BlueprintPage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [installing, setInstalling] = useState(new URLSearchParams(location.search).has("install"));
  const [soul, setSoul] = useState(false);
  const servers = lastValue(useMcpServers().servers.resource) ?? [];
  const has = (preset: string | null) => preset !== null && servers.some((server) => server.presetId === preset && (server.status === "ready" || server.status === "connected"));

  useEffect(() => {
    let current = true;

    detach(Effect.catchCause(Effect.map(Effect.promise(() => readBlueprint(blueprint)), (read) => { if (current) setPage(read); }), showing((chain) => { if (current) setFailure(chain); })));

    return () => { current = false; };
  }, [blueprint, tries]);

  if (failure !== null) return <div className="p-8"><LoadFailure what="this workspace" message={failure} onRetry={() => setTries((n) => n + 1)} /></div>;

  if (page === null) return <div className="flex h-full items-center justify-center"><Loader size="base" /></div>;
  const { workspace, inside } = page;

  return (
    <div className="h-full overflow-y-auto" data-blueprint-page={workspace.id}>
      <div className="mx-auto w-full max-w-[1080px] px-4 pb-16 pt-5 sm:px-8 sm:pt-7">
        <nav className="flex items-center gap-1 p-meta p-text-3" aria-label="Breadcrumb">
          <Link to="/explore" className="hover:p-text">Explore</Link><CaretRightIcon size={10} />
          <Link to="/explore?kind=workspace" className="hover:p-text">Workspaces</Link>
        </nav>

        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div className="relative aspect-[16/10] overflow-hidden rounded-[18px] border p-border p-recessed">
            {workspace.picture !== null && <img src={pictureSrc(blueprintPicturePath(workspace.id, workspace.picture))} alt={`${workspace.title} at work`} className="absolute inset-0 size-full object-cover object-left-top" />}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <span className="flex flex-wrap items-center gap-2"><KindBadge kind="workspace" /><span className="p-meta p-text-3">{CATEGORY_WORDS[workspace.category]}</span></span>
            <h1 className="p-display text-[30px] leading-tight p-text">{workspace.title}</h1>
            <p className="p-row-text p-text-2">{workspace.line}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 p-meta p-text-3">
              <Maker maker={workspace.maker} size={20} />
              <span className="inline-flex items-center gap-1"><DownloadSimpleIcon size={13} />{workspace.installs.toLocaleString("en-US")} installs</span>
              <span className="inline-flex items-center gap-1"><StarIcon size={13} />{workspace.stars.toLocaleString("en-US")}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <FilledButton onClick={() => setInstalling(true)} data-blueprint-install><DownloadSimpleIcon size={14} />Install</FilledButton>
              <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg border p-border px-3 text-[13px] p-text-2 transition-colors hover:p-text">
                <StarIcon size={14} />Star
              </button>
            </div>
            <p className="mt-3 flex items-start gap-2 rounded-xl bg-[var(--c-neutral-tint)] px-3 py-2.5 p-meta p-text-2">
              <ArrowsClockwiseIcon size={13} className="mt-0.5 shrink-0" />
              {`${workspace.maker.kinu ? "Kept by Kinu. " : ""}Version ${page.version}, updated ${ago(page.updatedAt)}. Installing makes a workspace of your own: change anything in it, and later versions leave it as it is.`}
            </p>
          </div>
        </div>

        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div className="space-y-8">
            <Section title="What it does">
              <div className="grid gap-3 sm:grid-cols-2">
                {page.about.map((item) => (
                  <div key={item.title} className="rounded-[14px] border p-border p-surface px-4 py-3">
                    <div className="p-row-text font-medium p-text">{item.title}</div>
                    <div className="mt-1 p-meta p-text-2">{item.body}</div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="What a new workspace holds">
              <ul className="divide-y divide-[var(--c-border)] overflow-hidden rounded-[14px] border p-border p-surface">
                {inside.agents.map((agent) => <Row key={agent.name} icon={<RobotIcon size={15} />} title={agent.name} meta="agent">{agent.about}</Row>)}
                {inside.automations.map((automation) => <Row key={automation.label} icon={<ClockIcon size={15} />} title={automation.label} meta={automation.when}>{automation.does}</Row>)}
                {inside.slates.map((slate) => <Row key={slate.title} icon={<AppWindowIcon size={15} />} title={slate.title} meta="slate">{slate.about}</Row>)}
                <Row icon={<LayoutIcon size={15} />} title={inside.layout === "focus" ? "Focus layout" : "Workbench layout"} meta="layout">
                  {inside.layout === "focus" ? "Its chat alone; its agents, tabs and inspector a click away." : "Chats as tabs, beside the inspector."}
                </Row>
              </ul>
              <button type="button" onClick={() => setSoul((shown) => !shown)} aria-expanded={soul} className="p-meta p-accent hover:underline">{soul ? "Hide its soul" : "Read its soul"}</button>
              {soul && <pre className="max-h-64 overflow-auto rounded-[14px] border p-border p-recessed p-4 p-t-code whitespace-pre-wrap p-text-2" data-blueprint-soul>{inside.soul}</pre>}
            </Section>
          </div>

          <div className="space-y-8">
            <Section title="What it needs of yours">
              <ul className="divide-y divide-[var(--c-border)] overflow-hidden rounded-[14px] border p-border p-surface">
                {workspace.needs.map((need) => <NeedRow key={`${need.connection ?? ""}${need.secret ?? ""}`} need={need} connected={has(need.connection)} />)}
                {workspace.needs.length === 0 && <li className="px-4 py-3 p-meta p-text-3">Nothing: it works with what any workspace has.</li>}
              </ul>
            </Section>
            <Section title="It asks you first">
              <ul className="space-y-2">
                {page.asks.map((ask) => (
                  <li key={ask} className="flex items-start gap-2.5 p-row-text p-text-2"><HandPalmIcon size={14} className="mt-0.5 shrink-0 p-accent" />{ask}</li>
                ))}
              </ul>
              <p className="p-meta p-text-3">Each is a card in Needs you. Allow one for good from its card, and take it back in Settings.</p>
            </Section>
          </div>
        </div>
      </div>
      {installing && <InstallDialog page={page} connected={has} onClose={() => setInstalling(false)} />}
    </div>
  );
}
