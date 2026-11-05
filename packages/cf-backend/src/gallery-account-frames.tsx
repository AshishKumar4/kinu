/** The account's frames: settings, setup, welcome, workspaces, plugins, devices, deploy and updates. */
import { Route, Routes } from "react-router-dom";
import { connectedPath, connectEndedOf } from "@kinu.run/core";
import Sidebar from "@/components/Sidebar";
import Layout from "@/components/layout";
import { APP_ROUTES } from "@kinu.run/core";
import WorkspacePage from "@/pages/WorkspacePage";
import { useAccount } from "@/hooks/use-account";
import { DriveRoute } from "@/gallery-drive";
import UserSettingsPage from "@/pages/UserSettingsPage";
import { JsonObjectSchema } from "@kinu.run/core";
import { lastValue } from "@/hooks/use-async-resource";
import type { DeploySnapshot } from "@kinu.run/core/deploy";
import * as v from "valibot";
import { serveGalleryRpc } from "@/gallery-agent-stub";
import { STUB, Shell, routedPage, type MountedFrame, workspacePageWire } from "@/gallery-shared";
import { CharactersFrame } from "@/gallery-characters";
import ConnectedPage from "@/pages/ConnectedPage";
import { DevicesFrame, PluginsFrame, SetupModalFrame, UserMcpFrame, WelcomeFrame, WorkspacesFrame } from "@/gallery-account";
import { SecretPasteFrame } from "@/gallery-secrets";
import { framed, type FrameTable } from "@/gallery-shared";

/** `&route=` is the app's own address for the wizard (`/welcome?step=providers`), as a sign-in returns to it. */
const WELCOME_ROUTE = new URLSearchParams(location.search).get("route") ?? "/welcome";

/** The finish page's own address (`&run=`, `&service=`, `&error=`), as a connect's callback writes it. A visual fixture:
 *  the connects themselves run through the Worker's own callbacks, in the live-app rows. */
const CONNECTED_AT = connectedPath(connectEndedOf(new URLSearchParams(location.search)));

/* A turn waiting on the provider: the wait is named on the task indicator rather than guessed from silence. */
function ProviderWaitFrame() {
  return <Shell providerWait={{ provider: "anthropic", untilMs: Date.now() + 45_000 }} />;
}

/** The shipped shell as App.tsx composes it; the background's contrast and UX gate are measured here. */
async function appShellFrame(): Promise<{ node: React.ReactNode; entries: string[] }> {
  const { default: HomePage, NewWorkspacePage } = await import("@/pages/HomePage");

  return {
    entries: [new URLSearchParams(location.search).get("path") ?? "/"],
    node: (
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="/user/settings"element={<UserSettingsPage />} />
          <Route path="/workspace/:agentId"element={<div className="h-full"data-gallery-blank />} />
          <Route path={APP_ROUTES.drive} element={<DriveRoute tab="mine"/>} />
          <Route path={APP_ROUTES.driveFolder} element={<DriveRoute tab="mine"/>} />
          <Route path={APP_ROUTES.slates} element={<DriveRoute tab="slates"/>} />
          <Route path={APP_ROUTES.shared} element={<DriveRoute tab="shared"/>} />
          <Route path={APP_ROUTES.newWorkspace} element={<NewWorkspacePage />} />
        </Route>
      </Routes>
    ),
  };
}

const GALLERY_UPDATE_RUN: DeploySnapshot = {
  runId: "self-update-0000",
  state: "running",
  address: "kinu.example.com",
  version: "0.4.0+cc33dd4",
  steps: [
    { id: "account", seq: 0, title: "Read the account", state: "done", attempt: 1, detail: "Acme Corp.", notes: [], failure: null, facts: {} },
    { id: "kv", seq: 1, title: "Create the KV namespaces", state: "done", attempt: 1, detail: "3 namespace(s) already there.", notes: [], failure: null, facts: {} },
    { id: "seed", seq: 2, title: "Seed the runtime cache", state: "done", attempt: 1, detail: "0 of 14 toolchain object(s) uploaded; the rest were already there.", notes: [], failure: null, facts: {} },
    { id: "upload", seq: 3, title: "Upload the Worker", state: "running", attempt: 1, detail: "", notes: ["41 of 212 assets uploaded"], failure: null, facts: {} },
    { id: "address", seq: 4, title: "Bind the address", state: "pending", attempt: 0, detail: "", notes: [], failure: null, facts: {} },
    { id: "smoke", seq: 5, title: "Check it answers", state: "pending", attempt: 0, detail: "", notes: [], failure: null, facts: {} },
  ],
  setupLink: null,
};

/** The deploy page alone, its door answered by `gallery-deploy-fixture.ts`: `&deploy=` names the state. */
async function deployFrame(): Promise<{ node: React.ReactNode; entries: string[] }> {
  const { default: DeployPage } = await import("@/pages/DeployPage");
  const at = new URLSearchParams(location.search).get("at") ?? "/deploy";

  return { entries: [at.startsWith("/deploy") ? at : "/deploy"], node: <DeployPage /> };
}

/** `?state=running` shows a run in flight; otherwise one build behind its channel. */
async function updatesFrame(): Promise<{ node: React.ReactNode; entries: string[] }> {
  const { default: UpdatesPage } = await import("@/pages/UpdatesPage");
  const running = new URLSearchParams(location.search).get("state") === "running";

  STUB.set("/api/updates", {
    current: { version: "0.3.9+aa11bb2", sha: "aa11bb2", builtAt: "2026-09-10T08:00:00.000Z" },
    available: { version: "0.4.0+cc33dd4", sha: "cc33dd4", builtAt: "2026-09-17T10:00:00.000Z" },
    channelOrigin: "https://kinu.run",
    upToDate: false,
    installable: true,
    reason: "",
  });
  // An idle deployment's ledger is empty.
  STUB.set("/api/updates/run", v.parse(JsonObjectSchema, running ? GALLERY_UPDATE_RUN : { ...GALLERY_UPDATE_RUN, state: "done", steps: [] }));

  return {
    entries: ["/updates"],
    node: (
      <div className="h-screen overflow-auto p-bg p-text">
        <UpdatesPage />
      </div>
    ),
  };
}

/** Routed: the page builds back-links and breadcrumbs from `agentId`. */
async function settingsFrame(): Promise<MountedFrame> {
  serveGalleryRpc(workspacePageWire);

  return routedPage("/workspace/api-worker/settings", "/workspace/:agentId/:view", <WorkspacePage />);
}

/** Routed: tab, account and workspace selection live in the URL. */
async function controlFrame(): Promise<MountedFrame> {
  const { default: ControlPage } = await import("@/pages/ControlPage");

  return routedPage("/control", "/control", <ControlPage />);
}

/** In the real chrome: the sidebar's route logic decides what renders at "/". */
async function homeFrame(): Promise<MountedFrame> {
  const { default: HomePage } = await import("@/pages/HomePage");

  return {
    entries: ["/"],
    node: (
      <div className="flex h-screen w-screen p-bg p-text overflow-hidden">
        <aside className="hidden w-60 shrink-0 p-sidebar border-r p-border md:block"><Sidebar /></aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden"><HomePage /></main>
      </div>
    ),
  };
}

/** Another reader of the shell's account, as the sidebar is: the name it holds, for a gate to compare with Settings'. */
function AccountReader() {
  const profile = lastValue(useAccount().profile);

  return <output hidden data-gallery-account-name>{profile?.displayName ?? ""}</output>;
}

/** `&section=devices` goes through the router: the page reads the hash off `useLocation`. `&shell=1` draws it inside
 *  the app's shell, beside another reader of the same account. */
function userSettingsStateFrame(): MountedFrame {
  const query = new URLSearchParams(location.search);
  const section = query.get("section");

  return {
    entries: [section === null ? "/user/settings" : `/user/settings#${section}`],
    node: query.get("shell") === "1"
      ? <><AccountReader /><Routes><Route element={<Layout />}><Route path="/user/settings" element={<UserSettingsPage />} /></Route></Routes></>
      : <div className="min-h-screen p-bg p-text"><UserSettingsPage /></div>,
  };
}

/** This module's frames, by `?frame=`: gallery.tsx mounts the one asked for. */
export const accountFrames: FrameTable = {
  secretpaste: () => framed(<SecretPasteFrame />),
  providerwait: () => framed(<ProviderWaitFrame />),
  // `&panel=providers|mcp|cli` picks the modal's body.
  setupmodal: () => framed(<SetupModalFrame />),
  // `&step=0..3` picks the wizard panel.
  welcome: () => framed(<WelcomeFrame />, [WELCOME_ROUTE]),
  // Where every connect ends, as a server's callback sends its tab there.
  connected: () => framed(<ConnectedPage />, [CONNECTED_AT]),
  // `&view=list` seeds the workspaces page's stored choice.
  workspaces: () => framed(<WorkspacesFrame />, ["/workspaces"]),
  plugins: () => framed(<PluginsFrame />, ["/plugins"]),
  devices: () => framed(<DevicesFrame />, ["/user/settings#devices"]),
  usermcp: () => framed(<UserMcpFrame />, ["/user/settings/mcp"]),
  characters: () => framed(<CharactersFrame />),
  "devices-empty": () => framed(<DevicesFrame />, ["/user/settings#devices"]),
  deploy: () => deployFrame(),
  updates: () => updatesFrame(),
  app: () => appShellFrame(),
  settings: () => settingsFrame(),
  control: () => controlFrame(),
  home: () => homeFrame(),
  usersettingsstate: () => userSettingsStateFrame(),
  mail: async () => {
    const { default: mailFrame } = await import("@/gallery-mail");

    return mailFrame();
  },
  mailpage: async () => {
    const { default: mailPageFrame } = await import("@/gallery-mailpage");

    return mailPageFrame();
  },
  // The free tier's screens (core limits/): `&state=` the account's stage, `&dialog=` a refusal (gallery-limits.tsx).
  limits: async () => {
    const { default: limitsFrame } = await import("@/gallery-limits");

    return limitsFrame();
  },
};
