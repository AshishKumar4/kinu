/**
 * Gallery frames for the account surfaces. Account settings itself is
 * `usersettingsstate` in gallery.tsx; this module holds the account frames
 * that mount panels onto other chrome, so `mount` stays a dispatch and the
 * frame bodies stay out of it.
 *
 *   /gallery.html?frame=setupmodal&panel=providers|mcp|cli
 *     → the home page's Setup card opening an account panel in place, with
 *       the shipped chrome (sidebar + HomePage) behind the modal.
 *
 *   /gallery.html?frame=workspaces[&view=list] and ?frame=plugins
 *     → the two primary-nav pages behind the shipped chrome (sidebar + page).
 *
 *   /gallery.html?frame=welcome&step=0..2
 *     → the onboarding wizard itself: full-screen, no chrome, stepped to the
 *       requested panel. The profile fixture answers `onboardedAt: null` for
 *       this frame, which is what makes the account a new one.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import * as v from "valibot";
import Sidebar from "@/components/Sidebar";
import { ACCOUNT_PANELS, AccountPanelModal } from "@/components/account/AccountPanelModal";

// The `home` frame pays this import only when it is the frame under
// photograph; the modal frame keeps the same boundary through lazy().
const HomePage = lazy(() => import("@/pages/HomePage"));

const WelcomePage = lazy(() => import("@/pages/WelcomePage"));

const WorkspacesPage = lazy(() => import("@/pages/WorkspacesPage"));

const PluginsPage = lazy(() => import("@/pages/PluginsPage"));

const DevicesPage = lazy(() => import("@/pages/DevicesPage"));

/** The shipped chrome around a primary-nav page: the rail, then the page. */
function Chrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-screen p-bg p-text overflow-hidden">
      <aside className="hidden w-60 shrink-0 p-sidebar border-r p-border md:block"><Sidebar /></aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>
          {children}
        </Suspense>
      </main>
    </div>
  );
}

export function WorkspacesFrame() {
  // The page reads its stored view once at mount, so the seed lands first;
  // tiles are the default, so the list is the choice that has to be stored.
  if (new URLSearchParams(location.search).get("view") === "list") localStorage.setItem("kinu:workspaces-view", "list");
  else localStorage.removeItem("kinu:workspaces-view");

  return <Chrome><WorkspacesPage /></Chrome>;
}

export function PluginsFrame() {
  return <Chrome><PluginsPage /></Chrome>;
}

export function DevicesFrame() {
  return <Chrome><DevicesPage /></Chrome>;
}

const AccountPanelParam = v.picklist(ACCOUNT_PANELS);

const WelcomeStepParam = v.picklist(["0", "1", "2"]);

/** The wizard alone: `mount` wraps every frame in the account provider, so
 *  the frame supplies nothing but the page — no sidebar, no chrome the wizard
 *  would never ship behind. */
export function WelcomeFrame() {
  const parsed = v.safeParse(WelcomeStepParam, new URLSearchParams(location.search).get("step"));

  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center p-bg"><Loader size="base" /></div>}>
      <WelcomePage initialStep={parsed.success ? Number(parsed.output) : 0} />
    </Suspense>
  );
}

export function SetupModalFrame() {
  const parsed = v.safeParse(AccountPanelParam, new URLSearchParams(location.search).get("panel"));

  return (
    <div className="flex h-screen w-screen p-bg p-text overflow-hidden">
      <aside className="hidden w-60 shrink-0 p-sidebar border-r p-border md:block"><Sidebar /></aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>
          <HomePage />
        </Suspense>
        {parsed.success && (
          // The dialog stays up for the capture.
          <AccountPanelModal panel={parsed.output} returnTo="/" onClose={() => {}} />
        )}
      </main>
    </div>
  );
}
