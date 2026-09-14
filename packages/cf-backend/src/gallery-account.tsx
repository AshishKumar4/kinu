/**
 * Gallery frames for the account surfaces. Account settings itself is
 * `usersettingsstate` in gallery.tsx; this module holds the account frames
 * that mount panels onto other chrome, so `mount` stays a dispatch and the
 * frame bodies stay out of it.
 *
 *   ?frame=setupmodal&panel=providers|mcp|cli
 *     → the home page's Setup card opening an account panel in place, with
 *       the shipped chrome (sidebar + HomePage) behind the modal.
 */
import { lazy, Suspense } from "react";
import { Loader } from "@cloudflare/kumo";
import * as v from "valibot";
import Sidebar from "@/components/Sidebar";
import { ACCOUNT_PANELS, AccountPanelModal } from "@/components/account/AccountPanelModal";

// The `home` frame pays this import only when it is the frame under
// photograph; the modal frame keeps the same boundary through lazy().
const HomePage = lazy(() => import("@/pages/HomePage"));

const AccountPanelParam = v.picklist(ACCOUNT_PANELS);

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
