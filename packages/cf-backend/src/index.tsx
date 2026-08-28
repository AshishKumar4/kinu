import "./index.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { pageDeployedBuildSha } from "./hooks/session-recovery";

// This page's build identity, read once HERE — at load, before anything has had
// a chance to fail. Both readers need the deployment that SERVED this document
// rather than whichever is live when they ask: the version-skew notice, which
// compares the two, and the render-failure report, whose stack coordinates are
// meaningless against any other build. Started eagerly and never awaited; it
// resolves to null on a dev server, which carries no build stamp.
void pageDeployedBuildSha();

// Theme is initialized in index.html <head> to prevent flash
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
