import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import { registerWorkspace, type WorkspaceEntry } from "@/lib/user-api";

/** Create a workspace from its mission (seeds SOUL.md and the title); not a chat turn. */
export function createWorkspaceFromMission(mission: string): Promise<WorkspaceEntry> {
  return settle(Effect.gen(function* () {
    const trimmed = mission.trim();

    if (!trimmed) return yield* Effect.die(new Error("Describe what the workspace is for."));

    return yield* Effect.promise(async () => registerWorkspace(undefined, trimmed));
  }));
}
