/**
 * The files a composer holds for its next message. Each uploads as it is added, through the workspace's files route
 * (`lib/attachments-api.ts`), with its progress on its chip; the message carries the paths those uploads answered, never
 * the bytes. Before a workspace exists (Home) a file is held as it is, and uploads once the workspace does.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import { Effect } from "effect";
import { FILE_TRANSFER_MAX_BYTES } from "@kinu.run/core";
import { attempt, detach, renderThrownChain } from "@kinu.run/core/obs";
import { uploadAttachment, uploadHref, uploadOfPart } from "@/lib/attachments-api";

/** Where a held file stands: waiting for a workspace, going (its share sent), kept at a path, or refused. */
export type AttachmentState =
  | { readonly kind: "held" }
  | { readonly kind: "uploading"; readonly share: number }
  | { readonly kind: "uploaded"; readonly path: string }
  | { readonly kind: "failed"; readonly error: string };

interface PendingAttachment {
  readonly key: string;
  /** Its bytes, where they are still here to send; null for an upload already kept (a reverted message's). */
  readonly file: File | null;
  readonly name: string;
  readonly mediaType: string;
  readonly state: AttachmentState;
}

/** A held file as its chip draws it: an uploaded image by its address on the plane. */
export interface ShownAttachment extends PendingAttachment {
  readonly preview: string | null;
}

type Action =
  | { readonly kind: "add"; readonly items: readonly PendingAttachment[] }
  | { readonly kind: "state"; readonly key: string; readonly state: AttachmentState }
  | { readonly kind: "remove"; readonly key: string }
  | { readonly kind: "clear" };

function reduce(items: readonly PendingAttachment[], action: Action): readonly PendingAttachment[] {
  if (action.kind === "add") return [...items, ...action.items];

  if (action.kind === "remove") return items.filter((item) => item.key !== action.key);

  if (action.kind === "clear") return [];

  return items.map((item) => (item.key === action.key ? { ...item, state: action.state } : item));
}

let keys = 0;

/** A file as the composer holds it: refused at once past what one upload carries, in the route's own terms. */
function held(file: File): PendingAttachment {
  keys += 1;
  const over = file.size > FILE_TRANSFER_MAX_BYTES;

  return {
    key: `attachment-${String(keys)}`, file, name: file.name, mediaType: file.type || "application/octet-stream",
    state: over ? { kind: "failed", error: `${file.name} is over the ${String(FILE_TRANSFER_MAX_BYTES / (1024 * 1024))} MiB one upload carries.` } : { kind: "held" },
  };
}

/** How one upload is watched: stopped by `stop`, its progress and end told to `told`, `done` once it stopped either way. */
interface UploadWatch {
  readonly stop: AbortController;
  readonly told: (state: AttachmentState) => void;
  readonly done: () => void;
}

/** `item`'s upload to `workspace`, as `watch` follows it. */
function uploadFor(workspace: string, item: PendingAttachment, watch: UploadWatch): Effect.Effect<void> {
  const { file } = item;
  const { stop, told, done } = watch;

  if (file === null) return Effect.sync(done);

  return Effect.ensuring(Effect.catch(
    Effect.map(attempt({ doing: `uploading ${file.name}`, otherwise: "io" }, async () => await uploadAttachment(workspace, file, {
      signal: stop.signal,
      sent: (share) => { told({ kind: "uploading", share }); },
    })), (path) => { told({ kind: "uploaded", path }); }),
    (failed) => Effect.sync(() => {
      if (!stop.signal.aborted) told({ kind: "failed", error: `${file.name}: ${renderThrownChain({ cause: failed })}` });
    }),
  ), Effect.sync(done));
}

/**
 * A press made while files are still uploading, held and carried out once they have all landed: Send never drops a
 * press. One that a refused file ends is let go (`refused`), the draft and its files left as they were.
 */
function useSendWhenUploaded(uploading: boolean, refused: boolean, run: () => void) {
  const [waiting, setWaiting] = useState(false);
  const latest = useRef(run);

  latest.current = run;
  useEffect(() => {
    if (!waiting || uploading) return;
    setWaiting(false);

    if (!refused) latest.current();
  }, [waiting, uploading, refused]);

  const request = useCallback((): void => {
    if (uploading) setWaiting(true);
    else latest.current();
  }, [uploading]);

  return { waiting, request };
}

/** Whether a composer's files are still on their way, or one will not land. */
export function uploadsOf(attachments: Pick<PendingAttachments, 'uploading' | 'refusal'> | undefined) {
  return { uploading: attachments?.uploading === true, refused: attachments?.refusal != null };
}

/**
 * A composer's submission held while its files upload (`useSendWhenUploaded`), and the notice it shows meanwhile. Held
 * twice: before `guard`, and before `submit`, which a guard may run later on its own (a secret offer's Send anyway), so
 * nothing is sent without its files. The composer holds its draft while either waits (`waiting`): the words a guard
 * approved are the words sent.
 */
export function useHeldSubmit(uploads: { readonly uploading: boolean; readonly refused: boolean }, guard: (act: () => void) => () => void, submit: () => void) {
  const inner = useSendWhenUploaded(uploads.uploading, uploads.refused, submit);
  const outer = useSendWhenUploaded(uploads.uploading, uploads.refused, guard(inner.request));
  const notices = outer.waiting || inner.waiting ? [{ id: "attach-wait", tone: "info" as const, text: "Sending once your files have uploaded." }] : [];

  return { request: outer.request, waiting: outer.waiting || inner.waiting, notices };
}

export interface PendingAttachments {
  readonly items: readonly ShownAttachment[];
  /** The message's file parts: each upload that landed, named by its path. */
  readonly parts: readonly FileUIPart[];
  /** Each file still held here, for a composer that carries them to a workspace not yet made (Home). */
  readonly files: readonly File[];
  /** Whether a file is still on its way: the message waits for it. */
  readonly uploading: boolean;
  readonly refusal: string | null;
  readonly add: (files: FileList | readonly File[] | null | undefined) => void;
  /** Parts a message already carried (a reverted one's, a new chat's opening): kept where they are uploads. */
  readonly offer: (parts: readonly FileUIPart[]) => void;
  readonly remove: (index: number) => void;
  readonly clear: () => void;
}

/** `workspace`: where files upload to; null holds them until there is one. */
export function usePendingAttachments(workspace: string | null): PendingAttachments {
  const [items, dispatch] = useReducer(reduce, []);
  const going = useRef(new Map<string, AbortController>());

  // Each held file uploads once there is a workspace for it; removing it, or leaving, stops it.
  useEffect(() => {
    if (workspace === null) return;

    const starting = items.filter((item) => item.state.kind === "held" && item.file !== null && !going.current.has(item.key)).map((item) => {
      const { key } = item;
      const stop = new AbortController();

      going.current.set(key, stop);
      dispatch({ kind: "state", key, state: { kind: "uploading", share: 0 } });

      return uploadFor(workspace, item, { stop, told: (state) => { dispatch({ kind: "state", key, state }); }, done: () => { going.current.delete(key); } });
    });

    // Run from the effect, which never awaits it: each upload tells its chip how far it is, and how it ended.
    detach(Effect.all(starting, { concurrency: "unbounded", discard: true }));
  }, [items, workspace]);

  useEffect(() => () => {
    for (const stop of going.current.values()) stop.abort();
  }, []);

  const add = useCallback((files: FileList | readonly File[] | null | undefined): void => {
    // Materialized now: a FileList empties when its input clears or its drop handler returns.
    const list = files === null || files === undefined ? [] : [...files];

    if (list.length > 0) dispatch({ kind: "add", items: list.map(held) });
  }, []);

  const offer = useCallback((parts: readonly FileUIPart[]): void => {
    const kept = parts.flatMap((part) => {
      const path = uploadOfPart(part);

      keys += 1;

      return path === null ? [] : [{
        key: `attachment-${String(keys)}`, file: null, name: part.filename ?? path.slice(path.lastIndexOf("/") + 1), mediaType: part.mediaType,
        state: { kind: "uploaded", path } as const,
      }];
    });

    if (kept.length > 0) dispatch({ kind: "add", items: kept });
    // A part stored before attachments were uploads carries its bytes: they upload again, as a file added now.
    const carried = parts.filter((part) => uploadOfPart(part) === null);

    if (carried.length === 0) return;
    detach(Effect.matchEffect(attempt({ doing: "reading a message's files back", otherwise: "unavailable" }, async () => await Promise.all(carried.map(async (part) => (
      new File([await (await fetch(part.url)).blob()], part.filename ?? "attachment", { type: part.mediaType })
    )))), {
      onSuccess: (files) => Effect.sync(() => { add(files); }),
      // Each comes back as a chip that says it could not: the person sees which, and why.
      onFailure: (failed) => Effect.sync(() => {
        dispatch({ kind: "add", items: carried.map((part) => {
          keys += 1;

          return {
            key: `attachment-${String(keys)}`, file: null, name: part.filename ?? "attachment", mediaType: part.mediaType,
            state: { kind: "failed", error: `${part.filename ?? "attachment"}: ${renderThrownChain({ cause: failed })}` } as const,
          };
        }) });
      }),
    }));
  }, [add]);

  const remove = useCallback((index: number): void => {
    const item = items[index];

    if (item === undefined) return;
    going.current.get(item.key)?.abort();
    dispatch({ kind: "remove", key: item.key });
  }, [items]);

  const clear = useCallback((): void => { dispatch({ kind: "clear" }); }, []);

  const parts = useMemo(() => items.flatMap((item): FileUIPart[] => (item.state.kind === "uploaded" && workspace !== null ? [{
    type: "file", filename: item.name, mediaType: item.mediaType, url: uploadHref(workspace, item.state.path),
    providerMetadata: { kinu: { upload: item.state.path } },
  }] : [])), [items, workspace]);

  const failures = items.flatMap((item) => (item.state.kind === "failed" ? [item.state.error] : []));

  return {
    items: items.map((item) => ({
      ...item, preview: item.state.kind === "uploaded" && workspace !== null && item.mediaType.startsWith("image/") ? uploadHref(workspace, item.state.path) : null,
    })),
    parts,
    files: items.flatMap((item) => (item.file === null ? [] : [item.file])),
    uploading: items.some((item) => item.state.kind === "held" || item.state.kind === "uploading"),
    refusal: failures.length === 0 ? null : failures.join(" "),
    add, offer, remove, clear,
  };
}
