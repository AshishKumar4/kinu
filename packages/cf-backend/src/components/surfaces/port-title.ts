import { executorLabel, type PinnedPreviewPort } from "@kinu.run/core";

/** What a preview tab is called: the name its app gave it, else the environment's own name and the port. */
export function portTitle(port: PinnedPreviewPort): string {
  return port.name === undefined || port.name === "" ? `${executorLabel(port.executor)} :${port.port}` : port.name;
}
