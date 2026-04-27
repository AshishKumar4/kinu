import "./index.css";
import { createRoot } from "react-dom/client";
import App from "./App";

// Theme is initialized in index.html <head> to prevent flash
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
