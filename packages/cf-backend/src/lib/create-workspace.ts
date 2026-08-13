import { registerWorkspace, type WorkspaceEntry } from "@/lib/user-api";

/** Create a workspace from its mission — the standing brief that seeds SOUL.md
 *  and titles the workspace. It is NOT a chat turn: the new workspace opens
 *  with an empty conversation, waiting for the first thing to do. */
export async function createWorkspaceFromMission(mission: string): Promise<WorkspaceEntry> {
  const trimmed = mission.trim();
  if (!trimmed) throw new Error("Mission required.");
  return registerWorkspace(undefined, trimmed);
}
