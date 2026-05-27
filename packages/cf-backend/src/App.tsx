import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Suspense, lazy } from "react";
import Layout from "./components/layout";
import HomePage from "./pages/HomePage";
import WorkspacePage from "./pages/WorkspacePage";
import SettingsPage from "./pages/SettingsPage";
import UserSettingsPage from "./pages/UserSettingsPage";
import { Loader } from "@cloudflare/kumo";

// MCTS explorer pulls d3 (~12KB) — split out of main bundle.
const MCTSExplorer = lazy(() => import("./pages/MCTSExplorer"));

function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader size="md" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="/user/settings" element={<UserSettingsPage />} />
          <Route path="/agent/:agentId" element={<WorkspacePage />} />
          <Route path="/mcts/:agentId" element={
            <Suspense fallback={<LazyFallback />}>
              <MCTSExplorer />
            </Suspense>
          } />
          <Route path="/settings/:agentId" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
