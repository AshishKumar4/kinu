/**
 * The single agent-creation flow, shared by the home-screen mission composer
 * and the home screen's mission card: models-connected gate, busy/error
 * state, createWorkspaceFromMission, and navigation into the new workspace.
 *
 * The mission does not ride along as a chat message. It is what the workspace
 * IS — its SOUL.md and its title — so the server owns it and the conversation
 * opens empty, waiting for the first thing to do.
 */
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createWorkspaceFromMission } from "@/lib/create-workspace";
import { listAvailableModels } from "@/lib/user-api";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { renderThrownChain } from '@kinu.run/core/obs';

/** The creation box's wording, in one place: both surfaces that render it read from here. */
export const MISSION_LABEL = "Mission";
export const MISSION_PLACEHOLDER =
  'A standing brief for the whole workspace. "My personal assistant, Jarvis." "Own the checkout service: find bugs, keep the tests green, ship the fixes."';
export const MISSION_HELP =
  "This becomes the workspace's SOUL.md and its name. Nothing runs until you send the first message.";
export const CONNECT_AI_MESSAGE = "Connect Cloudflare Workers AI before creating a workspace.";

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
      navigate(`/workspace/${created.name}`);
    } catch (e) {
      setErr(renderThrownChain({ cause: e }));
      setBusy(false);
    }
  }, [busy, navigate]);

  return { hasModels, busy, err, create };
}
