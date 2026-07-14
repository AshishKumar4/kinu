import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { Suspense, lazy } from "react";
import Layout from "./components/layout";
import HomePage from "./pages/HomePage";
import WorkspacePage from "./pages/WorkspacePage";
import SettingsPage from "./pages/SettingsPage";
import UserSettingsPage from "./pages/UserSettingsPage";
import UserMcpPage from "./pages/UserMcpPage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Loader } from "@cloudflare/kumo";

// MCTS explorer pulls d3 (~12KB) — split out of main bundle.
const MCTSExplorer = lazy(() => import("./pages/MCTSExplorer"));

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

// Trigger management folded into the Supervise altitude's Automations block;
// old /triggers deep links land there.
function TriggersRedirect() {
  const { agentId } = useParams();
  return <Navigate to={`/workspace/${agentId}?altitude=supervise`} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<ErrorBoundary label="home"><HomePage /></ErrorBoundary>} />
          <Route path="/user/settings" element={<ErrorBoundary label="user-settings"><UserSettingsPage /></ErrorBoundary>} />
          <Route path="/user/settings/mcp" element={<ErrorBoundary label="user-mcp"><UserMcpPage /></ErrorBoundary>} />
          <Route path="/workspace/:agentId" element={<ErrorBoundary label="workspace"><KeyedWorkspace /></ErrorBoundary>} />
          <Route path="/workspace/:agentId/agents/:subName" element={<ErrorBoundary label="workspace-agent"><KeyedWorkspace /></ErrorBoundary>} />
          <Route path="/mcts/:agentId" element={
            <ErrorBoundary label="mcts-explorer">
              <Suspense fallback={<LazyFallback />}>
                <MCTSExplorer />
              </Suspense>
            </ErrorBoundary>
          } />
          <Route path="/settings/:agentId" element={<ErrorBoundary label="agent-settings"><SettingsPage /></ErrorBoundary>} />
          <Route path="/triggers/:agentId" element={<TriggersRedirect />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
