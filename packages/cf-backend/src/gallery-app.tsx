/**
 * The whole app in one frame, the owner's one demo surface: every page is the page itself over its own fixture, reached
 * through the app's own sidebar, and every proposal under review is a switch or a state on its design bar
 * (gallery-design-bar.tsx), held across pages by the gallery's address. Home is the assistant; the roster is its account's
 * (`&roster=` names another); a workspace opens on the long turn; `&env=computer&pc=granted&pcdesktop=ready` gives it its
 * computer and the owner's PC. `&at=<path>` opens a page, and follows the page on screen.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { APP_ROUTES } from "@kinu.run/core";
import Layout from "@/components/layout";
import WorkspacePage from "@/pages/WorkspacePage";
import UserSettingsPage from "@/pages/UserSettingsPage";
import { settingsPath } from "@/components/SettingsRail";
import MailPage from "@/pages/MailPage";
import type { SocketCall } from "@/lib/workspace-rpc";
import { seedGalleryChat, serveGalleryRpc } from "@/gallery-agent-stub";
import { ASSISTANT_THREAD, AssistantHome, assistantRpc } from "@/gallery-assistant";
import { EXPLORE_LISTINGS, installExploreFixture } from "@/gallery-explore";
import { installGalleryFixture } from "@/gallery-listings";
import { DriveRoute } from "@/gallery-drive";
import { installMailPageFixture } from "@/gallery-mailpage";
import { SelfDeployFlow } from "@/gallery-self-deploy";
import { DesignBar, KeepPlace, PhoneWindow, startDesign, useDesign } from "@/gallery-design-bar";

const WorkspacesPage = lazy(() => import("@/pages/WorkspacesPage"));

const PluginsPage = lazy(() => import("@/pages/PluginsPage"));


const ExplorePage = lazy(() => import("@/pages/ExplorePage"));

const ExploreWorkspacePage = lazy(() => import("@/pages/ExploreWorkspacePage"));

const WelcomePage = lazy(() => import("@/pages/WelcomePage"));

const GallerySlatePage = lazy(() => import("@/pages/GallerySlatePage"));

const NewWorkspacePage = lazy(async () => ({ default: (await import("@/pages/HomePage")).NewWorkspacePage }));

const loading = (page: ReactNode): ReactNode => (
  <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>{page}</Suspense>
);

/** The route on screen: the one socket answers as the assistant on Home and as its own workspace elsewhere. */
let onScreen = "";

/** Mounted before the routes, so a page's chat is seeded before it opens its socket: Home is the assistant's morning. */
function Seeder({ transcript }: { transcript: (name: string) => void }) {
  const { pathname } = useLocation();

  if (pathname !== onScreen) {
    onScreen = pathname;

    if (pathname === APP_ROUTES.home) seedGalleryChat(ASSISTANT_THREAD);
    else if (pathname.startsWith("/workspace/")) transcript("longturn");
  }

  return null;
}

/** Inside the phone window the app is drawn alone; around it, the design bar holds the switches. */
const IN_PHONE = new URLSearchParams(location.search).get("device") === "frame";

function Pages() {
  // Keyed on the background, so New workspace draws the field asked for at once (AppBackground.tsx).
  const { background } = useDesign();

  return (
    <Routes key={background}>
      <Route element={<Layout />}>
        <Route index element={<AssistantHome />} />
        <Route path={APP_ROUTES.workspaces} element={loading(<WorkspacesPage />)} />
        <Route path={APP_ROUTES.newWorkspace} element={loading(<NewWorkspacePage />)} />
        <Route path={APP_ROUTES.drive} element={<DriveRoute tab="mine" />} />
        <Route path={APP_ROUTES.driveFolder} element={<DriveRoute tab="mine" />} />
        <Route path={APP_ROUTES.slates} element={<DriveRoute tab="slates" />} />
        <Route path={APP_ROUTES.shared} element={<DriveRoute tab="shared" />} />
        <Route path={APP_ROUTES.explore} element={loading(<ExplorePage />)} />
        <Route path={APP_ROUTES.exploreWorkspace} element={loading(<ExploreWorkspacePage />)} />
        <Route path={APP_ROUTES.plugins} element={loading(<PluginsPage />)} />
        <Route path={APP_ROUTES.gallerySlate} element={loading(<GallerySlatePage />)} />
        <Route path={APP_ROUTES.devices} element={<Navigate to={settingsPath("devices")} replace />} />
        <Route path="/mail/*" element={<MailPage />} />
        <Route path="/workspace/:agentId" element={<WorkspacePage />} />
        <Route path="/workspace/:agentId/agents/:subName" element={<WorkspacePage />} />
        <Route path={APP_ROUTES.workspaceAgentPath} element={<WorkspacePage />} />
        <Route path="/workspace/:agentId/:view" element={<WorkspacePage />} />
        <Route path={APP_ROUTES.userSettings} element={<UserSettingsPage />} />
        <Route path="*" element={<Navigate to={APP_ROUTES.home} replace />} />
      </Route>
      <Route path={APP_ROUTES.welcome} element={loading(<WelcomePage initialStep={0} />)} />
      <Route path="/deploy" element={<SelfDeployFlow />} />
    </Routes>
  );
}

function WholeApp({ transcript }: { transcript: (name: string) => void }) {
  const { device } = useDesign();

  if (IN_PHONE) return <><Seeder transcript={transcript} /><KeepPlace /><Pages /></>;

  return (
    <>
      <Seeder transcript={transcript} />
      <KeepPlace />
      {/* `bar=off`: a page drawn inside another review page (the system frame's page kinds) without its own switches. */}
      {device === "phone" ? <PhoneWindow><DesignBar /></PhoneWindow> : <><Pages />{new URLSearchParams(location.search).get("bar") === "off" ? null : <DesignBar />}</>}
    </>
  );
}

export function appFrame(base: SocketCall, transcript: (name: string) => void) {
  const assistant = assistantRpc(base);

  serveGalleryRpc(<T,>(method: string, args?: unknown[]): Promise<T> => (onScreen === APP_ROUTES.home ? assistant<T>(method, args) : base<T>(method, args)));
  installExploreFixture();
  installMailPageFixture();
  installGalleryFixture("whole", EXPLORE_LISTINGS);
  startDesign();

  return { entries: [new URLSearchParams(location.search).get("at") ?? APP_ROUTES.home], node: <WholeApp transcript={transcript} /> };
}
