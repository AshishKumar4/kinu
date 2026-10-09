import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useParams } from "react-router-dom";
import { Suspense, type ReactNode } from "react";
import Layout from "./components/layout";
import HomePage from "./pages/HomePage";
import WorkspacePage from "./pages/WorkspacePage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { APP_ROUTES, needsOnboarding } from "@kinu.run/core";
import { AccountProvider, useAccount } from "@/hooks/use-account";
import { lastValue } from "./hooks/use-async-resource";
import { lazyRoute } from "./lazy-route";
import { Loader } from "@cloudflare/kumo";

// Split routes go through `lazyRoute`, not `lazy`, to recover from a chunk gone stale across a deploy.

// The swarm explorer pulls d3.
const SwarmExplorer = lazyRoute(() => import("./pages/SwarmExplorer"));

// Home and the workspace are the first chunk; every other page loads when it is opened.
const UserSettingsPage = lazyRoute(() => import("./pages/UserSettingsPage"));

const UserMcpPage = lazyRoute(() => import("./pages/UserMcpPage"));

const WelcomePage = lazyRoute(() => import("./pages/WelcomePage"));

const DrivePage = lazyRoute(() => import("./pages/DrivePage"));

const WorkspacesPage = lazyRoute(() => import("./pages/WorkspacesPage"));

const PluginsPage = lazyRoute(() => import("./pages/PluginsPage"));

const DevicesPage = lazyRoute(() => import("./pages/DevicesPage"));

const BlueprintPage = lazyRoute(() => import("./pages/BlueprintPage"));

const LiveSharePage = lazyRoute(() => import("./pages/LiveSharePage"));

const ConnectedPage = lazyRoute(() => import("./pages/ConnectedPage"));

// Operator-only.
const ControlPage = lazyRoute(() => import("./pages/ControlPage"));

const DeployPage = lazyRoute(() => import("./pages/DeployPage"));

const UpdatesPage = lazyRoute(() => import("./pages/UpdatesPage"));

function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader size="base" />
    </div>
  );
}

/** A route's page: its own error boundary, and a loader while a split page's chunk arrives. */
function Page({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ErrorBoundary label={label}>
      <Suspense fallback={<LazyFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

// Remount (and reconnect useAgent) per workspace; subordinate routes keep the key so the main socket stays mounted.
function KeyedWorkspace() {
  const { agentId } = useParams();

  return <WorkspacePage key={agentId} />;
}

// An account needing setup lands on /welcome from any URL; /welcome stays open to all; a failed profile read gates nothing.
function OnboardingGate() {
  const { profile } = useAccount();
  const at = useLocation().pathname;

  if (profile.status === "loading") return <LazyFallback />;

  if (at !== APP_ROUTES.welcome && needsOnboarding(lastValue(profile))) {
    return <Navigate to={APP_ROUTES.welcome} replace />;
  }

  return <Outlet />;
}

// Paths come from `APP_ROUTES` so the router and failure reports' route field cannot drift.
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Outside the onboarding gate: a sign-in that ends here mid-setup must not land on the setup's first step. */}
        <Route path={APP_ROUTES.connected} element={<Page label="connected"><ConnectedPage /></Page>} />
        <Route element={<AccountProvider><OnboardingGate /></AccountProvider>}>
          <Route path={APP_ROUTES.welcome} element={<Page label="welcome"><WelcomePage /></Page>} />
          <Route element={<Layout />}>
            <Route index element={<Page label="home"><HomePage /></Page>} />
            <Route path={APP_ROUTES.userSettings} element={<Page label="user-settings"><UserSettingsPage /></Page>} />
            <Route path={APP_ROUTES.userMcp} element={<Page label="user-mcp"><UserMcpPage /></Page>} />
            <Route path={APP_ROUTES.drive} element={<Page label="drive"><DrivePage tab="mine" /></Page>} />
            <Route path={APP_ROUTES.driveFolder} element={<Page label="drive-folder"><DrivePage tab="mine" /></Page>} />
            <Route path={APP_ROUTES.shared} element={<Page label="shared"><DrivePage tab="shared" /></Page>} />
            <Route path={APP_ROUTES.workspaces} element={<Page label="workspaces"><WorkspacesPage /></Page>} />
            <Route path={APP_ROUTES.plugins} element={<Page label="plugins"><PluginsPage /></Page>} />
            <Route path={APP_ROUTES.devices} element={<Page label="devices"><DevicesPage /></Page>} />
            <Route path={APP_ROUTES.workspace} element={<Page label="workspace"><KeyedWorkspace /></Page>} />
            <Route path={APP_ROUTES.workspaceAgent} element={<Page label="workspace-agent"><KeyedWorkspace /></Page>} />
            <Route path={APP_ROUTES.workspaceAgentPath} element={<Page label="workspace-agent"><KeyedWorkspace /></Page>} />
            <Route path={APP_ROUTES.workspaceView} element={<Page label="workspace-view"><KeyedWorkspace /></Page>} />
            <Route path={APP_ROUTES.explore} element={<Page label="swarm-explorer"><SwarmExplorer /></Page>} />
            <Route path={APP_ROUTES.control} element={<Page label="control-plane"><ControlPage /></Page>} />
            <Route path={APP_ROUTES.updates} element={<Page label="updates"><UpdatesPage /></Page>} />
          </Route>
        </Route>
        {/* Outside the shell: a viewer without a session sees this page and nothing else. */}
        <Route path={APP_ROUTES.sharedBlueprint} element={<Page label="blueprint"><BlueprintPage /></Page>} />
        {/* Outside onboarding too: a person a share names enters it before setting anything up. */}
        <Route path={APP_ROUTES.sharedLive} element={<Page label="shared-live"><LiveSharePage /></Page>} />
        <Route path={APP_ROUTES.deploy} element={<Page label="deploy"><DeployPage /></Page>} />
      </Routes>
    </BrowserRouter>
  );
}
