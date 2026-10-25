import { createContext, useContext } from "react";

/** The workspace on screen, as its page resolved it: its route's, or Home's assistant, which Home shows with no route of
 *  its own. A view inside the page reads it here; the route names no workspace on Home. */
const OpenWorkspaceContext = createContext<string | null>(null);

export const OpenWorkspaceProvider = OpenWorkspaceContext.Provider;

export function useOpenWorkspace(): string | null {
  return useContext(OpenWorkspaceContext);
}
