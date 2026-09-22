import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useParams } from "react-router-dom";
import { Suspense } from "react";
import Layout from "./components/layout";
import HomePage from "./pages/HomePage";
import WorkspacePage from "./pages/WorkspacePage";
import SettingsPage from "./pages/SettingsPage";
import UserSettingsPage from "./pages/UserSettingsPage";
import UserMcpPage from "./pages/UserMcpPage";
import WelcomePage from "./pages/WelcomePage";
import DrivePage from "./pages/DrivePage";
import WorkspacesPage from "./pages/WorkspacesPage";
import PluginsPage from "./pages/PluginsPage";
import DevicesPage from "./pages/DevicesPage";
import BlueprintPage from "./pages/BlueprintPage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { APP_ROUTES, needsOnboarding } from "@kinu.run/core";
import { AccountProvider, useAccount } from "@/hooks/use-account";
import { lastValue } from "./hooks/use-async-resource";
import { lazyRoute } from "./lazy-route";
import { Loader } from "@cloudflare/kumo";

// Split routes go through `lazyRoute`, not `lazy`, to recover from a chunk gone stale across a deploy.

// MCTS explorer pulls d3.
const MCTSExplorer = lazyRoute(() => import("./pages/MCTSExplorer"));

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

// Remount (and reconnect useAgent) per workspace; subordinate routes keep the key so the main socket stays mounted.
function KeyedWorkspace() {
  const { agentId } = useParams();

  return <WorkspacePage key={agentId} />;
}

// Keyed per workspace: unkeyed, the fetch-once ref and pending edits survive a switch and Save writes A's form into B.
function KeyedSettings() {
  const { agentId } = useParams();

  return <SettingsPage key={agentId} />;
}

// /triggers deep links land in Supervise's Automations block.
function TriggersRedirect() {
  const { agentId } = useParams();

  return <Navigate to={`/workspace/${agentId}?altitude=supervise`} replace />;
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
        <Route element={<AccountProvider><OnboardingGate /></AccountProvider>}>
          <Route path={APP_ROUTES.welcome} element={<ErrorBoundary label="welcome"><WelcomePage /></ErrorBoundary>} />
          <Route element={<Layout />}>
            <Route index element={<ErrorBoundary label="home"><HomePage /></ErrorBoundary>} />
            <Route path={APP_ROUTES.userSettings} element={<ErrorBoundary label="user-settings"><UserSettingsPage /></ErrorBoundary>} />
            <Route path={APP_ROUTES.userMcp} element={<ErrorBoundary label="user-mcp"><UserMcpPage /></ErrorBoundary>} />
            <Route path={APP_ROUTES.drive} element={<ErrorBoundary label="drive"><DrivePage /></ErrorBoundary>} />
            <Route path={APP_ROUTES.driveFolder} element={<ErrorBoundary label="drive-folder"><DrivePage /></ErrorBoundary>} />
            <Route path={APP_ROUTES.workspaces} element={<ErrorBoundary label="workspaces"><WorkspacesPage /></ErrorBoundary>} />
            <Route path={APP_ROUTES.plugins} element={<ErrorBoundary label="plugins"><PluginsPage /></ErrorBoundary>} />
            <Route path={APP_ROUTES.devices} element={<ErrorBoundary label="devices"><DevicesPage /></ErrorBoundary>} />
            <Route path={APP_ROUTES.workspace} element={<ErrorBoundary label="workspace"><KeyedWorkspace /></ErrorBoundary>} />
            <Route path={APP_ROUTES.workspaceAgent} element={<ErrorBoundary label="workspace-agent"><KeyedWorkspace /></ErrorBoundary>} />
            <Route path={APP_ROUTES.explore} element={
              <ErrorBoundary label="mcts-explorer">
                <Suspense fallback={<LazyFallback />}>
                  <MCTSExplorer />
                </Suspense>
              </ErrorBoundary>
            } />
            <Route path={APP_ROUTES.control} element={
              <ErrorBoundary label="control-plane">
                <Suspense fallback={<LazyFallback />}>
                  <ControlPage />
                </Suspense>
              </ErrorBoundary>
            } />
            <Route path={APP_ROUTES.updates} element={
              <ErrorBoundary label="updates">
                <Suspense fallback={<LazyFallback />}>
                  <UpdatesPage />
                </Suspense>
              </ErrorBoundary>
            } />
            <Route path={APP_ROUTES.agentSettings} element={<ErrorBoundary label="agent-settings"><KeyedSettings /></ErrorBoundary>} />
            <Route path={APP_ROUTES.triggers} element={<TriggersRedirect />} />
          </Route>
        </Route>
        {/* Outside the shell: a viewer without a session sees this page and nothing else. */}
        <Route path={APP_ROUTES.sharedBlueprint} element={<ErrorBoundary label="blueprint"><BlueprintPage /></ErrorBoundary>} />
        <Route path={APP_ROUTES.deploy} element={
          <ErrorBoundary label="deploy">
            <Suspense fallback={<LazyFallback />}>
              <DeployPage />
            </Suspense>
          </ErrorBoundary>
        } />
      </Routes>
    </BrowserRouter>
  );
}
