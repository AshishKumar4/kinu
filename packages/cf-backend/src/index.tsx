import "virtual:kinu-theme.css";
import "./index.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { startTheme } from "./hooks/use-theme";

// The head painted the mode (core's MODE_BOOT); from here the store holds it and follows the system.
startTheme();

const mount = document.getElementById("root");

if (mount === null) throw new Error("missing #root mount point");

const root = createRoot(mount);

root.render(<App />);
