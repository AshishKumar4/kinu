/**
 * The whole app in one frame, the owner's one demo surface: every page is the page itself over its own fixture, reached
 * through the app's own sidebar, and every proposal under review is a switch or a state on its design bar
 * (gallery-design-bar.tsx), held across pages by the gallery's address. Home is the assistant; the roster is its account's
 * (`&roster=` names another); a workspace opens on the long turn; `&env=computer&pc=granted&pcdesktop=ready` gives it its
 * computer and the owner's PC. `&at=<path>` opens a page, and follows the page on screen.
 */
import { Suspense, type ReactNode } from "react";
import { lazyRoute } from "@/lazy-route";
import { Route, Routes, useLocation } from "react-router-dom";
import { Loader } from "@/components/ui/Loader";
import { APP_ROUTES } from "@kinu.run/core";
import Layout from "@/components/layout";
import { LISTED_SLATE_ROUTE, shellRoutes } from "@/App";
import type { SocketCall } from "@/lib/workspace-rpc";
import { seedGalleryChat, serveGalleryRpc } from "@/gallery-agent-stub";
import { ASSISTANT_THREAD, AssistantHome, assistantRpc } from "@/gallery-assistant";
import { EXPLORE_LISTINGS, installExploreFixture } from "@/gallery-explore";
import { installGalleryFixture } from "@/gallery-listings";
import { DriveRoute } from "@/gallery-drive";
import { installMailPageFixture } from "@/gallery-mailpage";
import DeployPage from "@/pages/DeployPage";
import { DesignBar, KeepPlace, PhoneWindow, startDesign, useDesign } from "@/gallery-design-bar";

const WelcomePage = lazyRoute(() => import("@/pages/WelcomePage"));

const loading = (page: ReactNode): ReactNode => (
  <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>{page}</Suspense>
);

/** The assistant's own pages (its Activity): its chat and socket, as on Home. */
const ASSISTANT_PATH = "/workspace/personal-assistant";

/** The route on screen: the one socket answers as the assistant on Home and its own pages, and as its own workspace elsewhere. */
let onScreen = "";

/** Mounted before the routes, so a page's chat is seeded before it opens its socket: Home is the assistant's morning. */
function Seeder({ transcript }: { transcript: (name: string) => void }) {
  const { pathname } = useLocation();

  if (pathname !== onScreen) {
    onScreen = pathname;

    if (pathname === APP_ROUTES.home || pathname.startsWith(ASSISTANT_PATH)) seedGalleryChat(ASSISTANT_THREAD);
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
      {/* The app's own pages, with the assistant on Home and Drive over its fixture. */}
      <Route element={<Layout />}>
        {shellRoutes({ home: <AssistantHome />, drive: (tab) => <DriveRoute tab={tab} /> })}
        {LISTED_SLATE_ROUTE}
      </Route>
      <Route path={APP_ROUTES.welcome} element={loading(<WelcomePage initialStep={0} />)} />
      <Route path="/deploy" element={<DeployPage />} />
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

  serveGalleryRpc(<T,>(method: string, args?: unknown[]): Promise<T> => (onScreen === APP_ROUTES.home || onScreen.startsWith(ASSISTANT_PATH) ? assistant<T>(method, args) : base<T>(method, args)));
  installExploreFixture();
  installMailPageFixture();
  installGalleryFixture("whole", EXPLORE_LISTINGS);
  startDesign();

  return { entries: [new URLSearchParams(location.search).get("at") ?? APP_ROUTES.home], node: <WholeApp transcript={transcript} /> };
}
