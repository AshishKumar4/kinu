import type { Rpc } from "@kinu.run/core";
import { InlineSlate } from "./InlineSlate";

/**
 * The work surface's full-height slate frame: the same component the chat
 * card renders, in `pane` display, so the preview URL, refusal and loader
 * treatment never drift between the two places a slate appears.
 */
export function SlateFrame({ id, rpc, reloadKey = 0, onReady }: {
  id: string;
  rpc: Rpc;
  /** Bumped when the Slate changes, so its preview URL is re-read. */
  reloadKey?: number;
  onReady?: () => void;
}) {
  return <InlineSlate id={id} rpc={rpc} display="pane" reloadKey={reloadKey} onReady={onReady} />;
}
