import "./index.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { primePageDeployedBuildSha } from "@kinu.run/core";

// Read at load: skew notice and failure report need the build that served this document, not the live one.
primePageDeployedBuildSha();

// Theme is initialized in index.html <head> to prevent flash
const mount = document.getElementById("root");

if (mount === null) throw new Error("missing #root mount point");

const root = createRoot(mount);

root.render(<App />);
