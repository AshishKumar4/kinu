/**
 * Gallery account frames: `setupmodal&panel=`, `workspaces[&view=list]`, `plugins`, `welcome&step=0..2`.
 * The `welcome` profile fixture answers `onboardedAt: null`, which makes the account new.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import * as v from "valibot";
import Sidebar from "@/components/Sidebar";
import { ACCOUNT_PANELS, AccountPanelModal } from "@/components/account/AccountPanelModal";

const HomePage = lazy(() => import("@/pages/HomePage"));

const WelcomePage = lazy(() => import("@/pages/WelcomePage"));

const WorkspacesPage = lazy(() => import("@/pages/WorkspacesPage"));

const PluginsPage = lazy(() => import("@/pages/PluginsPage"));

const DevicesPage = lazy(() => import("@/pages/DevicesPage"));

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
  // The page reads its stored view once at mount, so seed it first.
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
