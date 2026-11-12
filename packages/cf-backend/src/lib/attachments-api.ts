/**
 * A chat attachment is an upload: sent before the message through the workspace's files route (the Files tab's), kept
 * under /uploads by its name (`placeUpload`), and named in the message by the path that route answers.
 */
import * as v from "valibot";
import { Effect } from "effect";
import { PLANE, uploadOfUiPart } from "@kinu.run/core";
import { settle } from "@kinu.run/core/obs";
import { request } from "./http";

const FILES = (workspace: string): string => `/api/workspaces/${encodeURIComponent(workspace)}/files?executor=${encodeURIComponent(PLANE)}`;

/** Where the browser reads an upload of `workspace`: its file on the plane, by its path. */
export function uploadHref(workspace: string, path: string): string {
  return `${FILES(workspace)}&path=${encodeURIComponent(path)}`;
}

/** The upload a part names (`uploadOfUiPart`): the same rule the workspace reads a sent part by. */
export const uploadOfPart = uploadOfUiPart;

/** `file` uploaded to `workspace`'s /uploads, telling `sent` how much of it has gone (0 to 1): the path it was kept at. */
export function uploadAttachment(workspace: string, file: File, watch: { readonly signal: AbortSignal; readonly sent: (share: number) => void }): Promise<string> {
  return settle(Effect.map(request(v.object({ ok: v.literal(true), path: v.string() }), `${FILES(workspace)}&uploads=${encodeURIComponent(file.name)}`, {
    method: "PUT",
    body: file,
    signal: watch.signal,
    sent: (bytes) => { watch.sent(file.size === 0 ? 1 : Math.min(1, bytes / file.size)); },
  }), (kept) => kept.path));
}
