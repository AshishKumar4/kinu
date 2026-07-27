/**
 * The single agent-creation flow, shared by the home-screen mission composer
 * and the sidebar's CreateWorkspaceModal: models-connected gate, busy/error
 * state, createWorkspaceFromMission, and navigation into the new agent with the
 * mission riding along as the opening message.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createWorkspaceFromMission } from "@/lib/create-workspace";
import { listAvailableModels } from "@/lib/user-api";

export function useCreateWorkspace() {
  const navigate = useNavigate();
  /** null = still loading; false = no providers connected. */
  const [hasModels, setHasModels] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listAvailableModels()
      .then((models) => setHasModels(models.length > 0))
      .catch(() => setHasModels(false));
  }, []);

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
