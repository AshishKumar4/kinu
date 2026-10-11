/** The workspace's chat and its reads over one socket, and a hosted agent's chat alone. */
import { useRef } from "react";
import { useChatOwner, type KinuActorAddress, type WorkspaceExtension } from "./use-chat-owner";
import { useWorkspaceReads } from "./use-workspace-reads";

/** The workspace's chat and its reads, over one socket. */
export function useKinu(workspace?: string) {
  const extension = useRef<WorkspaceExtension | null>(null);
  const { chat, link } = useChatOwner(workspace, extension);
  const { reads, extension: own, error } = useWorkspaceReads(link);
  extension.current = own;

  return { ...chat, ...reads, error };
}

/** One hosted agent's chat, without the workspace's reads. */
export function useActorChat(address: KinuActorAddress) {
  return useChatOwner(address, null).chat;
}
