/**
 * Gallery account frames: `setupmodal&panel=`, `workspaces[&view=list]`, `plugins`, `welcome&step=0..4`.
 * The `welcome` profile fixture answers `onboardedAt: null`, which makes the account new.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import * as v from "valibot";
import { ONBOARDING_STEPS } from "@kinu.run/core";
import Sidebar from "@/components/Sidebar";
import { ACCOUNT_PANELS, AccountPanelModal } from "@/components/account/AccountPanelModal";
import { NewWorkspaceIconButton } from "@/components/workspaces/NewWorkspaceButton";

const HomePage = lazy(() => import("@/pages/HomePage"));

const WelcomePage = lazy(() => import("@/pages/WelcomePage"));

const WorkspacesPage = lazy(() => import("@/pages/WorkspacesPage"));

const PluginsPage = lazy(() => import("@/pages/PluginsPage"));

const UserSettingsPage = lazy(() => import("@/pages/UserSettingsPage"));

const UserMcpPage = lazy(() => import("@/pages/UserMcpPage"));

/** The app's frame as these pages meet it: the sidebar, and on a phone the app bar with its New (layout.tsx). */
function Chrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-screen flex-col p-bg p-text overflow-hidden md:flex-row">
      <header className="flex h-14 shrink-0 items-center justify-end border-b p-border p-sidebar px-3 md:hidden">
        <NewWorkspaceIconButton className="size-9 rounded-full" />
      </header>
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

/** Settings' Devices section, where devices live (the old `/devices` address redirects there). */
export function DevicesFrame() {
  return <Chrome><UserSettingsPage /></Chrome>;
}

export function UserMcpFrame() {
  return <Chrome><UserMcpPage /></Chrome>;
}

const AccountPanelParam = v.picklist(ACCOUNT_PANELS);

const WelcomeStepParam = v.picklist(ONBOARDING_STEPS.map((_, index) => String(index)));

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
          <AccountPanelModal panel={parsed.output} onClose={() => {}} />
        )}
      </main>
    </div>
  );
}
