import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Suspense, lazy } from "react";
import Layout from "./components/layout";
import HomePage from "./pages/HomePage";
import WorkspacePage from "./pages/WorkspacePage";
import SettingsPage from "./pages/SettingsPage";
import { Loader } from "@cloudflare/kumo";

// Lazy-load the MCTS explorer — it imports d3 (~60KB gzipped) and is only
// reached when the user clicks the MCTS tab, so we keep it out of the main
// bundle and split it into its own chunk.
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
