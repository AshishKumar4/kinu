import { registerWorkspace, type WorkspaceEntry } from "@/lib/user-api";

/** Create a workspace from its mission (seeds SOUL.md and the title); not a chat turn. */
export async function createWorkspaceFromMission(mission: string): Promise<WorkspaceEntry> {
  const trimmed = mission.trim();

  if (!trimmed) throw new Error("Describe what the workspace is for.");

  return registerWorkspace(undefined, trimmed);
}
