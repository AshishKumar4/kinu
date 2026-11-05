import { BrowserRouter, Routes, Route, Navigate, Outlet, matchPath, useLocation, useParams } from "react-router-dom";
import { Suspense, useEffect, type ReactNode } from "react";
import Layout from "./components/layout";
import GalleryShell, { VisitorShell } from "./components/gallery/GalleryShell";
import HomePage, { NewWorkspacePage } from "./pages/HomePage";
import { WorkspacePage } from "./pages/workspace-route";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { APP_ROUTES, needsOnboarding, pageIsVisitors } from "@kinu.run/core";
import { AccountProvider, useAccount } from "@/hooks/use-account";
import { setupFinishing } from "@/lib/setup-finish";
import { lastValue } from "./hooks/use-async-resource";
import { lazyRoute } from "./lazy-route";
import { Loader } from "@/components/ui/Loader";

// Split routes go through `lazyRoute`, not `lazy`, to recover from a chunk gone stale across a deploy.

// The swarm explorer pulls d3.
const SwarmExplorer = lazyRoute(() => import("./pages/SwarmExplorer"));

// Home and the workspace are the first chunk; every other page loads when it is opened.
const UserSettingsPage = lazyRoute(() => import("./pages/UserSettingsPage"));

const UserMcpPage = lazyRoute(() => import("./pages/UserMcpPage"));

const WelcomePage = lazyRoute(() => import("./pages/WelcomePage"));

const DrivePage = lazyRoute(() => import("./pages/DrivePage"));

const GallerySlatePage = lazyRoute(() => import("./pages/GallerySlatePage"));

const ExplorePage = lazyRoute(() => import("./pages/ExplorePage"));

const ExploreWorkspacePage = lazyRoute(() => import("./pages/ExploreWorkspacePage"));

const WorkspacesPage = lazyRoute(() => import("./pages/WorkspacesPage"));

const PluginsPage = lazyRoute(() => import("./pages/PluginsPage"));

const MailPage = lazyRoute(() => import("./pages/MailPage"));

const BlueprintPage = lazyRoute(() => import("./pages/BlueprintPage"));

const LiveSharePage = lazyRoute(() => import("./pages/LiveSharePage"));

const PartFramePage = lazyRoute(() => import("./pages/PartFramePage"));

const ConnectedPage = lazyRoute(() => import("./pages/ConnectedPage"));

// Operator-only.
const ControlPage = lazyRoute(() => import("./pages/ControlPage"));

const DeployPage = lazyRoute(() => import("./pages/DeployPage"));

const UpdatesPage = lazyRoute(() => import("./pages/UpdatesPage"));

const InvitePage = lazyRoute(() => import("./pages/InvitePage"));

const NotFoundPage = lazyRoute(() => import("./pages/NotFoundPage"));

function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader size="base" />
    </div>
  );
}

/**
 * A route's page: its own error boundary, and a loader while a split page's chunk arrives. Each page mounts its own: a
 * navigation is a transition, and one that suspends inside a boundary the last page already showed keeps that page on
 * screen under the new address until the new one is ready (#130). `page` names it where the label does not: one
 * workspace's routes share their boundary, so its socket stays mounted across them.
 */
function Page({ label, page = label, children }: { label: string; page?: string; children: ReactNode }) {
  return (
    <ErrorBoundary key={page} label={label}>
      <Suspense fallback={<LazyFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/** A workspace's routes, each under its label, on one boundary per workspace: its page remounts (and reconnects
 *  useAgent) per workspace, and its agent and view routes keep it, so the main socket stays mounted. */
function WorkspaceRoute({ label }: { label: string }) {
  const { agentId } = useParams();

  return <Page label={label} page={`workspace:${agentId ?? ''}`}><WorkspacePage /></Page>;
}

// An account needing setup lands on /welcome from any URL; /welcome stays open to all; a failed profile read gates nothing.
// A workspace does not wait for the read: its socket is the page's longest wait, which the read delayed 453 ms on the
// mobile profile (2026-10-09), and an account holding a workspace never needs setup (`needsOnboarding`).
function OnboardingGate() {
  const { profile } = useAccount();
  const at = useLocation().pathname;

  if (profile.status === "loading" && matchPath(`${APP_ROUTES.workspace}/*`, at) === null) return <LazyFallback />;

  // A finish this page began is let through while its stamp is saved (`setupFinishing`).
  if (at !== APP_ROUTES.welcome && needsOnboarding(lastValue(profile)) && !setupFinishing()) {
    return <Navigate to={APP_ROUTES.welcome} replace />;
  }

  return <Outlet />;
}

/** Explore's pages: in the rail for the signed in, under the public bar for a visitor. */
const EXPLORE_ROUTES = (
  <>
    <Route path={APP_ROUTES.explore} element={<Page label="explore"><ExplorePage /></Page>} />
    <Route path={APP_ROUTES.exploreWorkspace} element={<Page label="explore-workspace"><ExploreWorkspacePage /></Page>} />
  </>
);

/** A listed slate's page: public, so the app hangs it outside its onboarding gate; the gallery draws it in its shell. */
export const LISTED_SLATE_ROUTE = <Route path={APP_ROUTES.gallerySlate} element={<Page label="gallery-slate"><GallerySlatePage /></Page>} />;

/** Drive's tabs, each its own address. */
type DriveTab = "mine" | "slates" | "shared";

/** Pages a caller draws its own way: the gallery's assistant on Home, and its Drive over a fixture. */
interface ShellPages {
  readonly home?: ReactNode;
  readonly drive?: (tab: DriveTab) => ReactNode;
}

/** The pages inside the signed-in shell, by address: the app's, and the gallery's whole app with its own Home and Drive. */
export function shellRoutes({ home = <HomePage />, drive = (tab) => <DrivePage tab={tab} /> }: ShellPages = {}) {
  return (
    <>
      <Route index element={<Page label="home">{home}</Page>} />
      <Route path={APP_ROUTES.newWorkspace} element={<Page label="new-workspace"><NewWorkspacePage /></Page>} />
      <Route path={APP_ROUTES.userSettings} element={<Page label="user-settings"><UserSettingsPage /></Page>} />
      <Route path={APP_ROUTES.userMcp} element={<Page label="user-mcp"><UserMcpPage /></Page>} />
      <Route path={APP_ROUTES.drive} element={<Page label="drive">{drive("mine")}</Page>} />
      <Route path={APP_ROUTES.driveFolder} element={<Page label="drive-folder">{drive("mine")}</Page>} />
      <Route path={APP_ROUTES.slates} element={<Page label="slates">{drive("slates")}</Page>} />
      <Route path={APP_ROUTES.shared} element={<Page label="shared">{drive("shared")}</Page>} />
      <Route path={APP_ROUTES.workspaces} element={<Page label="workspaces"><WorkspacesPage /></Page>} />
      <Route path={APP_ROUTES.plugins} element={<Page label="plugins"><PluginsPage /></Page>} />
      <Route path={`${APP_ROUTES.mail}/*`} element={<Page label="mail"><MailPage /></Page>} />
      <Route path={APP_ROUTES.workspace} element={<WorkspaceRoute label="workspace" />} />
      <Route path={APP_ROUTES.workspaceAgent} element={<WorkspaceRoute label="workspace-agent" />} />
      <Route path={APP_ROUTES.workspaceAgentPath} element={<WorkspaceRoute label="workspace-agent" />} />
      <Route path={APP_ROUTES.workspaceView} element={<WorkspaceRoute label="workspace-view" />} />
      <Route path={APP_ROUTES.swarm} element={<Page label="swarm-explorer"><SwarmExplorer /></Page>} />
      {EXPLORE_ROUTES}
      <Route path={APP_ROUTES.control} element={<Page label="control-plane"><ControlPage /></Page>} />
      <Route path={APP_ROUTES.updates} element={<Page label="updates"><UpdatesPage /></Page>} />
      <Route path={APP_ROUTES.invite} element={<Page label="invite"><InvitePage /></Page>} />
      <Route path="*" element={<Page label="not-found"><NotFoundPage /></Page>} />
    </>
  );
}

/** A visitor's way to a page that is not public: its address is the server's to answer, with sign-in first. */
function ServerPage() {
  const { pathname, search } = useLocation();

  useEffect(() => { window.location.assign(pathname + search); }, [pathname, search]);

  return <LazyFallback />;
}

/**
 * A visitor's page, as the server marked it (`pageIsVisitors`): Explore under the public bar, reading nothing of an
 * account, and a listed slate's page as anyone sees it.
 */
const VISITOR_ROUTES = (
  <>
    <Route path={APP_ROUTES.connected} element={<Page label="connected"><ConnectedPage /></Page>} />
    <Route element={<VisitorShell />}>{EXPLORE_ROUTES}</Route>
    <Route element={<GalleryShell />}>{LISTED_SLATE_ROUTE}</Route>
    <Route path="*" element={<Page label="server"><ServerPage /></Page>} />
  </>
);

// Paths come from `APP_ROUTES` so the router and failure reports' route field cannot drift.
export default function App({ visitor = pageIsVisitors() }: { readonly visitor?: boolean }) {
  if (visitor) return <BrowserRouter><Routes>{VISITOR_ROUTES}</Routes></BrowserRouter>;

  return (
    <BrowserRouter>
      <Routes>
        {/* Outside the onboarding gate: a sign-in that ends here mid-setup must not land on the setup's first step. */}
        <Route path={APP_ROUTES.connected} element={<Page label="connected"><ConnectedPage /></Page>} />
        <Route element={<AccountProvider><OnboardingGate /></AccountProvider>}>
          <Route path={APP_ROUTES.welcome} element={<Page label="welcome"><WelcomePage /></Page>} />
          <Route element={<Layout />}>{shellRoutes()}</Route>
        </Route>
        {/* A listed slate's page is public: the app's shell signed in, a bar with Sign in signed out (GalleryShell). */}
        <Route element={<GalleryShell />}>{LISTED_SLATE_ROUTE}</Route>
        {/* Outside the shell: a viewer without a session sees this page and nothing else. */}
        <Route path={APP_ROUTES.sharedBlueprint} element={<Page label="blueprint"><BlueprintPage /></Page>} />
        {/* Outside onboarding too: a person a share names enters it before setting anything up. */}
        <Route path={APP_ROUTES.sharedLive} element={<Page label="shared-live"><LiveSharePage /></Page>} />
        {/* One personal part of a shared slate, in the app's own frame inside the slate's page. */}
        <Route path={APP_ROUTES.liveSlatePart} element={<Page label="live-slate-part"><PartFramePage /></Page>} />
        <Route path={APP_ROUTES.deploy} element={<Page label="deploy"><DeployPage /></Page>} />
      </Routes>
    </BrowserRouter>
  );
}
