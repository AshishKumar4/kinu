/**
 * A workspace blueprint's page on Explore: what it does, what a new workspace from it holds (its agents, its schedules
 * and watches, its slates, its layout and soul), what it needs of yours and what it asks you before acting; and Install.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Page } from "@/components/ui/PageHeader";
import { Link, useParams } from "react-router-dom";
import { Effect } from "effect";
import { Loader } from "@/components/ui/Loader";
import { ClockIcon, HandPalmIcon, HouseIcon, KeyIcon, LayoutIcon, RobotIcon, StarIcon, AppWindowIcon, DownloadSimpleIcon } from "@phosphor-icons/react";
import { APP_ROUTES, mcpPresetById, PERSONAL_ASSISTANT_ID } from "@kinu.run/core";
import { detach, showing } from "@kinu.run/core/obs";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Status } from "@/components/ui/Status";
import { BrandMark } from "@/components/ui/BrandMark";
import { presetBrand } from "@/components/plugins/McpPresetCards";
import { CATEGORY_WORDS } from "@/components/sharing/words";
import { KindBadge, Maker, kinuBlueprintPicture } from "@/components/explore/ExploreCard";
import { InstallDialog } from "@/components/explore/InstallDialog";
import { useConnectedPreset } from "@/hooks/use-mcp-servers";
import { readBlueprint, starBlueprint, type BlueprintPage, type ExploreNeed, type WorkspaceCard } from "@/lib/explore-api";
import { useInstalledAssistant } from "@/hooks/use-installed-assistant";
import { useGallerySignedIn } from "@/hooks/use-gallery-signed-in";
import { hereAsking, signInAndReturn } from "@/lib/sign-in";

const ago = (at: number) => {
  const days = Math.round((Date.now() - at) / 864e5);

  return days <= 0 ? "today" : `${String(days)} day${days === 1 ? "" : "s"} ago`;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="t-label">{title}</h2>
      {children}
    </section>
  );
}

function Row({ icon, title, meta, children }: { icon: ReactNode; title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--c-hover)] p-text-2">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="t-item p-text">{title}</span>
          {meta !== undefined && <span className="t-meta p-text-3">{meta}</span>}
        </span>
        {children !== undefined && <span className="t-meta block p-text-2">{children}</span>}
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
      <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--c-hover)]">
        {brand !== undefined ? <BrandMark brand={brand} size={14} bare /> : <KeyIcon size={14} className="p-text-2" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2">
          <span className="t-item p-text">{name}</span>
          <span className="t-meta p-text-3">{need.access === "read" ? "to read" : "to read and write"}</span>
        </span>
        <span className="t-meta block p-text-2">{need.why}</span>
      </span>
      {connected ? <Status tone="success">Connected</Status> : <span className="t-meta shrink-0 p-text-3">At install</span>}
    </li>
  );
}

/** Install, or Open for the assistant the person already has; and a star of their own, counted with everyone's. Signed out, each signs in first. */
function BlueprintActions({ workspace, onInstall }: { workspace: WorkspaceCard; onInstall: () => void }) {
  const signedIn = useGallerySignedIn();
  const assistant = useInstalledAssistant();
  const [star, setStar] = useState({ on: workspace.starred, count: workspace.stars });
  const [failure, setFailure] = useState<string | null>(null);
  const installed = workspace.id === PERSONAL_ASSISTANT_ID && assistant.status === "ready" && assistant.value !== null;

  const toggle = (on: boolean) => Effect.catchCause(
    Effect.map(Effect.promise(() => starBlueprint(workspace.id, on)), () => {
      setFailure(null);
      setStar((prior) => ({ on, count: prior.count + (on ? 1 : -1) }));
    }),
    showing(setFailure),
  );

  // The page's header actions: Star, then the one primary.
  return (
    <>
      {failure !== null && <span role="alert" className="t-meta max-w-64 truncate p-danger" title={failure}>{failure}</span>}
      <Button onClick={() => detach(signedIn ? toggle(!star.on) : Effect.sync(() => signInAndReturn()))} aria-pressed={star.on} data-blueprint-star>
        <StarIcon size={14} weight={star.on ? "fill" : "regular"} className={star.on ? "p-accent-fg" : undefined} />
        {star.on ? "Starred" : "Star"}<span className="tabular-nums p-text-3">{star.count.toLocaleString("en-US")}</span>
      </Button>
      {installed
        ? <Link to={APP_ROUTES.home} className={buttonClass({ variant: "primary" })} data-blueprint-open><HouseIcon size={14} />Open on Home</Link>
        : <Button variant="primary" onClick={signedIn ? onInstall : () => signInAndReturn(hereAsking("install"))} data-blueprint-install><DownloadSimpleIcon size={14} />Install</Button>}
    </>
  );
}

export default function ExploreWorkspacePage() {
  const { blueprint = "" } = useParams();
  const signedIn = useGallerySignedIn();
  const [page, setPage] = useState<BlueprintPage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let current = true;

    detach(Effect.catchCause(Effect.map(Effect.promise(() => readBlueprint(blueprint)), (read) => { if (current) setPage(read); }), showing((chain) => { if (current) setFailure(chain); })));

    return () => { current = false; };
  }, [blueprint, tries]);

  if (failure !== null) return <div className="p-8"><LoadFailure what="this workspace" message={failure} onRetry={() => setTries((n) => n + 1)} /></div>;

  if (page === null) return <div className="flex h-full items-center justify-center"><Loader size="base" /></div>;

  return signedIn ? <AccountBlueprint page={page} /> : <Blueprint page={page} connected={NOTHING_CONNECTED} />;
}

/** A visitor signed out has connected nothing, and has no account to ask. */
const NOTHING_CONNECTED = (): boolean => false;

/** Signed in, each need says whether the person has already connected it. */
function AccountBlueprint({ page }: { page: BlueprintPage }) {
  return <Blueprint page={page} connected={useConnectedPreset()} />;
}

function Blueprint({ page, connected }: { page: BlueprintPage; connected: (preset: string) => boolean }) {
  const signedIn = useGallerySignedIn();
  const [installing, setInstalling] = useState(signedIn && new URLSearchParams(location.search).has("install"));
  const [soul, setSoul] = useState(false);
  const has = (preset: string | null) => preset !== null && connected(preset);
  const { workspace, inside } = page;

  return (
    <Page back={{ to: "/explore?kind=workspace", label: "Back to Explore" }} icon={null} title={workspace.title} data-blueprint-page={workspace.id}
      actions={<BlueprintActions workspace={workspace} onInstall={() => setInstalling(true)} />}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="relative aspect-[16/10] overflow-hidden rounded-[var(--r-card)] border p-border p-sunken">
          {workspace.picture !== null && <img src={kinuBlueprintPicture(workspace.picture)} alt={`${workspace.title} at work`} className="absolute inset-0 size-full object-cover object-left-top" />}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <span className="flex flex-wrap items-center gap-2"><KindBadge kind="workspace" /><span className="t-meta p-text-3">{CATEGORY_WORDS[workspace.category]}</span></span>
          <p className="t-body p-text-2">{workspace.line}</p>
          <div className="t-meta flex flex-wrap items-center gap-x-4 gap-y-1 p-text-3">
            <Maker maker={workspace.maker} size={20} />
            <span className="inline-flex items-center gap-1"><DownloadSimpleIcon size={13} />{workspace.installs.toLocaleString("en-US")} {workspace.installs === 1 ? "install" : "installs"}</span>
            <span className="tabular-nums">Version {page.version} · updated {ago(page.updatedAt)}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-12 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <div className="space-y-8">
          <Section title="What it does">
            <div className="grid gap-3 sm:grid-cols-2">
              {page.about.map((item) => (
                <div key={item.title} className="rounded-[var(--r-card)] border p-border p-surface px-4 py-3">
                  <div className="t-item p-text">{item.title}</div>
                  <div className="t-meta mt-1 p-text-2">{item.body}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="What a new workspace holds">
            <ul className="divide-y divide-[var(--c-border)] overflow-hidden rounded-[var(--r-card)] border p-border p-surface">
              {inside.agents.map((agent) => <Row key={agent.name} icon={<RobotIcon size={15} />} title={agent.name} meta="agent">{agent.about}</Row>)}
              {inside.automations.map((automation) => <Row key={automation.label} icon={<ClockIcon size={15} />} title={automation.label} meta={automation.when}>{automation.does}</Row>)}
              {inside.slates.map((slate) => <Row key={slate.title} icon={<AppWindowIcon size={15} />} title={slate.title} meta="slate">{slate.about}</Row>)}
              <Row icon={<LayoutIcon size={15} />} title={inside.layout === "focus" ? "Focus layout" : "Workbench layout"} meta="layout">
                {inside.layout === "focus" ? "Its chat alone; its agents, tabs and inspector a click away." : "Chats as tabs, beside the inspector."}
              </Row>
            </ul>
            <Button variant="ghost" size="sm" onClick={() => setSoul((shown) => !shown)} aria-expanded={soul}>{soul ? "Hide its soul" : "Read its soul"}</Button>
            {soul && <pre className="t-code max-h-64 overflow-auto rounded-[var(--r-card)] border p-border p-sunken p-4 whitespace-pre-wrap p-text-2" data-blueprint-soul>{inside.soul}</pre>}
          </Section>
        </div>

        <div className="space-y-8">
          <Section title="What it needs of yours">
            <ul className="divide-y divide-[var(--c-border)] overflow-hidden rounded-[var(--r-card)] border p-border p-surface">
              {workspace.needs.map((need) => <NeedRow key={`${need.connection ?? ""}${need.secret ?? ""}`} need={need} connected={has(need.connection)} />)}
              {workspace.needs.length === 0 && <li className="t-meta px-4 py-3 p-text-3">Nothing: it works with what any workspace has.</li>}
            </ul>
          </Section>
          <Section title="It asks you first">
            <ul className="space-y-2">
              {page.asks.map((ask) => (
                <li key={ask} className="t-body flex items-start gap-3 p-text-2"><HandPalmIcon size={14} className="mt-px shrink-0 p-accent-fg" />{ask}</li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
      {installing && <InstallDialog page={page} connected={has} onClose={() => setInstalling(false)} />}
    </Page>
  );
}
