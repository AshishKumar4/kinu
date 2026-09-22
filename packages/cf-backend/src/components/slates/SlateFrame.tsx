import type { Rpc } from "@kinu.run/core";
import { InlineSlate } from "./InlineSlate";

/** The chat card's component in `pane` display, so both slate views stay in step. */
export function SlateFrame({ id, rpc, reloadKey = 0, onReady }: {
  id: string;
  rpc: Rpc;
  reloadKey?: number;
  onReady?: () => void;
}) {
  return <InlineSlate id={id} rpc={rpc} display="pane" reloadKey={reloadKey} onReady={onReady} />;
}
