import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/layout";
import HomePage from "./pages/HomePage";
import WorkspacePage from "./pages/WorkspacePage";
import MCTSExplorer from "./pages/MCTSExplorer";
import SettingsPage from "./pages/SettingsPage";
import V2Panel from "./pages/V2Panel";

export default function App() {
	return (
		<BrowserRouter>
			<Routes>
				<Route element={<Layout />}>
					<Route index element={<HomePage />} />
					<Route path="/agent/:agentId" element={<WorkspacePage />} />
					<Route path="/mcts/:agentId" element={<MCTSExplorer />} />
					<Route path="/v2/:agentId" element={<V2Panel />} />
					<Route path="/settings/:agentId" element={<SettingsPage />} />
				</Route>
			</Routes>
		</BrowserRouter>
	);
}
