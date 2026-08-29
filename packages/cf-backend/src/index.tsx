import "./index.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { primePageDeployedBuildSha } from "./hooks/session-recovery";

// This page's build identity, read once HERE — at load, before anything has had
// a chance to fail. Both readers need the deployment that SERVED this document
// rather than whichever is live when they ask: the version-skew notice, which
// compares the two, and the render-failure report, whose stack coordinates are
// meaningless against any other build. Started eagerly through the guarded
// primer (`primePageDeployedBuildSha`): a rejection from the shared baseline
// read is named there rather than left unhandled on a page still loading.
primePageDeployedBuildSha();

// Theme is initialized in index.html <head> to prevent flash
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
