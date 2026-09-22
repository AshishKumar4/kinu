import { createContext } from "react";
import type { Rpc } from "@kinu.run/core";

/** Null where a surface cannot host a frame; `slate://` links then render as code. */
export const SlateInlineContext = createContext<{
  rpc: Rpc;
  openSlate?: (id: string) => void;
} | null>(null);
