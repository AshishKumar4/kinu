import { InlineSlate } from "./InlineSlate";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

/** The chat card's component in `pane` display, so both slate views stay in step. */
export function SlateFrame({ id, rpc, reloadKey = 0, onReady }: {
  id: string;
  rpc: WorkspaceRpc;
  reloadKey?: number;
  onReady?: () => void;
}) {
  return <InlineSlate id={id} rpc={rpc} display="pane" reloadKey={reloadKey} onReady={onReady} />;
}
