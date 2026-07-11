import { BrowserRouter, Routes, Route, useParams } from "react-router-dom";
import { Suspense, lazy } from "react";
import Layout from "./components/layout";
import HomePage from "./pages/HomePage";
import WorkspacePage from "./pages/WorkspacePage";
import SettingsPage from "./pages/SettingsPage";
import UserSettingsPage from "./pages/UserSettingsPage";
import UserMcpPage from "./pages/UserMcpPage";
import TriggersTab from "./pages/TriggersTab";
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

// Remount the whole workspace — and with it the useAgent/useAgentChat hooks and
// their message buffer — whenever the agent changes. Without the key, switching
// /workspace/A → /workspace/B reuses the same component instance and one session's
// messages bleed into the next.
function KeyedWorkspace() {
  const { agentId } = useParams();
  return <WorkspacePage key={agentId} />;
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
          <Route path="/mcts/:agentId" element={
            <ErrorBoundary label="mcts-explorer">
              <Suspense fallback={<LazyFallback />}>
                <MCTSExplorer />
              </Suspense>
            </ErrorBoundary>
          } />
          <Route path="/settings/:agentId" element={<ErrorBoundary label="agent-settings"><SettingsPage /></ErrorBoundary>} />
          <Route path="/triggers/:agentId" element={<ErrorBoundary label="triggers"><TriggersTab /></ErrorBoundary>} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
