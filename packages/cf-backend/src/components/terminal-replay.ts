/**
 * A frame with no machine behind it (the landing's sample workspace): each executor's terminal replays what it ran,
 * read-only, instead of opening its socket, and a computer shows no screen. Null everywhere else. Its own module, so a
 * surface can read it without loading the terminal's chunk.
 */
import { createContext } from "react";
import type { TerminalPaneOutput } from "@kinu.run/core";

export const TerminalReplay = createContext<ReadonlyMap<string, readonly TerminalPaneOutput[]> | null>(null);
