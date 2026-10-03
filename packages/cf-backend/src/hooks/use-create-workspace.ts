/** Shared agent-creation flow. The mission becomes the workspace's SOUL.md and title server-side, not a chat message. */
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createWorkspaceFromMission } from "@/lib/create-workspace";
import { listAvailableModels } from "@/lib/user-api";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { Cause, Effect } from 'effect';
import { renderThrownChain, settle } from '@kinu.run/core/obs';

export const MISSION_LABEL = "Mission";

export const MISSION_PLACEHOLDER = "What would you like help with?";

export const CONNECT_AI_MESSAGE = "Connect Cloudflare Workers AI before creating a workspace.";

export function useCreateWorkspace() {
  const navigate = useNavigate();
  const roster = useWorkspaceRoster();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadModels = useCallback(() => listAvailableModels(), []);
  const { resource } = useAsyncResource(loadModels);
  const menu = lastValue(resource);
  /** Only `false` (an empty listing) blocks creation; a failed read leaves null and the create call reports it. */
  const hasModels = menu === null ? null : menu.models.length > 0;

  /** `onBeforeNavigate` lets a modal dismiss itself first. */
  const create = useCallback((mission: string, onBeforeNavigate?: () => void): Promise<void> => {
    const m = mission.trim();

    if (!m || busy) return Promise.resolve();
    setBusy(true);
    setErr(null);

    return settle(Effect.catchCause(Effect.gen(function* () {
      const created = yield* Effect.promise(() => createWorkspaceFromMission(m));
      roster.upsert(created);
      onBeforeNavigate?.();
      yield* Effect.promise(async () => navigate(`/workspace/${created.name}`));
    }), (failed) => Effect.sync(() => {
      setErr(renderThrownChain({ cause: Cause.squash(failed) }));
      setBusy(false);
    })));
  }, [busy, navigate, roster]);

  return { hasModels, busy, err, create };
}
