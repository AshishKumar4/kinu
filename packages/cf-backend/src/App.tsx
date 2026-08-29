import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { Suspense } from "react";
import Layout from "./components/layout";
import HomePage from "./pages/HomePage";
import WorkspacePage from "./pages/WorkspacePage";
import SettingsPage from "./pages/SettingsPage";
import UserSettingsPage from "./pages/UserSettingsPage";
import UserMcpPage from "./pages/UserMcpPage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { APP_ROUTES } from "./app-routes";
import { lazyRoute } from "./lazy-route";
import { Loader } from "@cloudflare/kumo";

// The two code-split routes, through `lazyRoute` rather than `lazy` directly.
// Both are `/assets/<name>-<hash>.js`, so both are the case a tab held open
// across a deploy cannot load at all; `lazy-route.tsx` owns the one guarded
// reload that recovers from it and the loader regeneration that makes the
// boundary's "Try again" actually re-attempt the import.

// MCTS explorer pulls d3 (~12KB) — split out of main bundle.
const MCTSExplorer = lazyRoute(() => import("./pages/MCTSExplorer"));

// The admin control plane. Split out because almost nobody who loads this app is
// an operator, and every read behind it answers 404 to everyone who is not — so
// its code has no business in the bundle every signed-in user downloads.
const ControlPage = lazyRoute(() => import("./pages/ControlPage"));

function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader size="base" />
    </div>
  );
}

// Remount the whole workspace — and with it the parent useAgent/useAgentChat
// hooks — when the workspace changes. Subordinate route changes intentionally
// keep this key stable so the main socket remains mounted while the active
// facet socket is swapped lazily.
function KeyedWorkspace() {
  const { agentId } = useParams();
  return <WorkspacePage key={agentId} />;
}

// The settings form belongs to ONE workspace, so a workspace change is a fresh
// mount for the same reason it is above.
//
// Unkeyed, React reuses the instance across `/workspace/A/settings` →
// `/workspace/B/settings` because the route pattern is the same and only the
// param changed. Two pieces of state then survive the switch: the fetch-once
// ref, so B's values are never loaded, and every pending edit, because
// `hydrate` deliberately keeps what the user typed. The form then showed A's
// approval mode, MCTS config and advisor settings while connected to B, and
// Save wrote them into B's Durable Object. Keying resets the ref, the five
// fields and anything later added beside them, which is why it is the key
// rather than a reset for each.
function KeyedSettings() {
  const { agentId } = useParams();
  return <SettingsPage key={agentId} />;
}

// Trigger management folded into the Supervise altitude's Automations block;
// old /triggers deep links land there.
function TriggersRedirect() {
  const { agentId } = useParams();
  return <Navigate to={`/workspace/${agentId}?altitude=supervise`} replace />;
}

// Every `path` below is read from `APP_ROUTES` rather than spelled here, so the
// router and a render-failure report's route field cannot drift: a path this file
// routes and that table does not know reports as `/unmatched`, which is a finding
// rather than a leak. (`app-routes.ts` states the whole reasoning.)
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<ErrorBoundary label="home"><HomePage /></ErrorBoundary>} />
          <Route path={APP_ROUTES.userSettings} element={<ErrorBoundary label="user-settings"><UserSettingsPage /></ErrorBoundary>} />
          <Route path={APP_ROUTES.userMcp} element={<ErrorBoundary label="user-mcp"><UserMcpPage /></ErrorBoundary>} />
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
          <Route path={APP_ROUTES.agentSettings} element={<ErrorBoundary label="agent-settings"><KeyedSettings /></ErrorBoundary>} />
          <Route path={APP_ROUTES.triggers} element={<TriggersRedirect />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
