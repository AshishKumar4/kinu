/**
 * The single agent-creation flow, shared by the home-screen mission composer
 * and the sidebar's CreateWorkspaceModal: models-connected gate, busy/error
 * state, createWorkspaceFromMission, and navigation into the new agent with the
 * mission riding along as the opening message.
 */
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createWorkspaceFromMission } from "@/lib/create-workspace";
import { listAvailableModels } from "@/lib/user-api";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";

export function useCreateWorkspace() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadModels = useCallback(() => listAvailableModels(), []);
  const { resource } = useAsyncResource(loadModels);
  const menu = lastValue(resource);
  /**
   * `false` — and only `false` — blocks creation behind the Connect Workers AI
   * wall, so it may be said only of a listing that came back empty. A failed
   * read leaves this null: creation stays enabled, and if there really is no
   * provider the create call says so itself.
   */
  const hasModels = menu === null ? null : menu.models.length > 0;

  /** Create + navigate. `onBeforeNavigate` lets a modal dismiss itself first. */
  const create = useCallback(async (mission: string, onBeforeNavigate?: () => void) => {
    const m = mission.trim();
    if (!m || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await createWorkspaceFromMission(m);
      onBeforeNavigate?.();
      navigate(`/workspace/${created.name}`, { state: { initialPrompt: created.mission } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [busy, navigate]);

  return { hasModels, busy, err, create };
}
