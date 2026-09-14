import { createContext } from "react";
import type { Rpc } from "@kinu.run/core";

/**
 * Where an inline slate card is rendered from: the workspace page installs
 * this once so a `slate://` link anywhere in the transcript can mount the
 * live preview. `openSlate` hops the same slate to its pane surface when the
 * card's chrome asks for it; surfaces that cannot host a frame leave the
 * context null and the link renders as code.
 */
export const SlateInlineContext = createContext<{
  rpc: Rpc;
  openSlate?: (id: string) => void;
} | null>(null);
