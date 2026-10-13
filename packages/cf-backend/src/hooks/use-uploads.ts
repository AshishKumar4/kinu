import { useCallback, useState } from "react";
import { Cause, Effect } from "effect";
import { FileWriteConflict } from "@kinu.run/core";
import { renderThrownChain, settle } from "@kinu.run/core/obs";
import type { VfsRevision } from "@nimbus-sh/core/vfs/vfs.js";

/**
 * An upload in flight, failed, or held, by the path it was dropped at: a file already there is replaced only when the
 * owner says so (`exists`, with the revision it holds), wherever they have browsed since, and a change between the
 * question and the answer asks again.
 */
type UploadState = { readonly target: string } & (
  | { readonly status: "uploading" }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "exists"; readonly file: File; readonly revision: VfsRevision });

export interface Uploads {
  readonly uploads: readonly UploadState[];
  /** Creates each file at its path; one already there is held for the owner. */
  readonly upload: (placed: readonly { readonly file: File; readonly target: string }[]) => Promise<void>;
  /** The owner's yes: replaces exactly the file they were shown, at the path it was dropped at. */
  readonly replace: (held: Extract<UploadState, { status: "exists" }>) => Promise<void>;
  readonly keep: (target: string) => void;
}

/** `put` writes a file's bytes: created where none is, or with `revision`, over exactly that revision. */
export function useUploads({ put, reload }: {
  put: (target: string, file: File, revision?: VfsRevision) => Promise<void>;
  reload: () => Promise<void>;
}): Uploads {
  const [uploads, setUploads] = useState<readonly UploadState[]>([]);

  const send = useCallback((file: File, target: string, revision?: VfsRevision) => Effect.catchCause(Effect.gen(function* () {
    yield* Effect.promise(async () => put(target, file, revision));
    setUploads((prev) => prev.filter((u) => u.target !== target));
  }), (failed) => {
    const conflict = Cause.squash(failed);

    // A file is there, or changed since the owner was asked: they choose again, over what it holds now.
    const held: UploadState = conflict instanceof FileWriteConflict
      ? { target, status: "exists", file, revision: conflict.currentRevision }
      : { target, status: "error", error: renderThrownChain({ cause: conflict }) };

    return Effect.sync(() => { setUploads((prev) => prev.map((u) => (u.target === target ? held : u))); });
  }), [put]);

  const upload = useCallback((placed: readonly { readonly file: File; readonly target: string }[]) => settle(Effect.gen(function* () {
    if (placed.length === 0) return;
    // Beside any upload still waiting on the owner: a new drop does not answer it.
    setUploads((prev) => [
      ...prev.filter((u) => !placed.some((p) => p.target === u.target)),
      ...placed.map(({ target }) => ({ target, status: "uploading" as const })),
    ]);

    for (const { file, target } of placed) yield* send(file, target);

    yield* Effect.promise(async () => reload());
  })), [reload, send]);

  const replace = useCallback((held: Extract<UploadState, { status: "exists" }>) => settle(Effect.gen(function* () {
    setUploads((prev) => prev.map((u) => (u.target === held.target ? { target: u.target, status: "uploading" as const } : u)));
    yield* send(held.file, held.target, held.revision);
    yield* Effect.promise(async () => reload());
  })), [reload, send]);

  const keep = useCallback((target: string) => {
    setUploads((prev) => prev.filter((u) => u.target !== target));
  }, []);

  return { uploads, upload, replace, keep };
}
