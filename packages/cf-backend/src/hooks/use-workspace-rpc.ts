/**
 * A workspace's RPC over its own socket, without its chat: the sidebar asks each workspace for its chats through this,
 * so the app's shell loads the agent socket alone and not the chat stack (`@cloudflare/ai-chat`, `ai` and their schemas).
 */
import { useCallback, useMemo, useState } from "react";
import { useAgent } from "agents/react";
import { ORCHESTRATOR_AGENT_SLUG } from "@kinu.run/core";
import { workspaceRpc } from "@/lib/workspace-rpc";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export function useWorkspaceRpc(agentId: string) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");

  const agent = useAgent({
    agent: ORCHESTRATOR_AGENT_SLUG,
    name: agentId,
    protocol: window.location.protocol === "https:" ? "wss" : "ws",
    onOpen: useCallback(() => setConnectionStatus("connected"), []),
    onClose: useCallback(() => setConnectionStatus("disconnected"), []),
    onError: useCallback(() => setConnectionStatus("error"), []),
  });

  return { rpc: useMemo(() => workspaceRpc(agent.call), [agent]), connectionStatus };
}
