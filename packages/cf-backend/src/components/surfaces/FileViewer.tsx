/**
 * One file, read and written through the plane the rest of the drive uses.
 *
 * Its own module because it is its own state machine — reading, an edit buffer,
 * a save in flight, and which form the text is rendered in — and the drive
 * around it shares none of that. The drive owns navigation; this owns one file.
 *
 * Text rides the viewer RPC; images and PDFs ride the raw-bytes route the
 * download uses. A save rides that same raw route with PUT — the identical call
 * the uploader makes, because a file's bytes have one way in.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader } from "@cloudflare/kumo";
import {
  CheckIcon, DownloadSimpleIcon, FileIcon, PencilSimpleIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import { renderThrownChain } from "@kinu.run/core/obs";
import type { Rpc } from "@/lib/protocol";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { MarkdownContent } from "./shared";
import {
  PLANE, FileWriteConflict, fileTextEditable, putFileBytes, sandboxedHtml, textRenderOf, viewerKindOf,
  type FileText, type TextRender,
} from "./files-plane";

export function FileViewer({ path, rpc, revision, rawHref, downloadHref, onSaved, onClose }: {
  path: string;
  rpc: Rpc;
  /** What the drive's current listing says this file's bytes are. A new value
   *  is a new read — that IS the cache invalidation, and there is no second
   *  copy of the text to keep in step with it. */
  revision: string;
  rawHref: string;
  downloadHref: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const kind = viewerKindOf(path);
  /** The edit buffer, or null while not editing. */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [asSource, setAsSource] = useState(false);

  const render = textRenderOf(path);
  /** What the body shows right now. One value, so the body below is a single
   *  dispatch instead of three conditions that each have to re-check the other
   *  two. */
  const body: TextRender | "edit" = draft !== null ? "edit" : asSource ? "source" : render;

  /**
   * The read, through the app's one tri-state fetch primitive.
   *
   * `useAsyncResource` owns the generation: its identity check makes the
   * rendered value "loading" the instant the identity changes, and only its
   * newest run may publish. The shape this replaced fired the RPC from an
   * effect and wrote whatever came back, so a reply for the file the reader had
   * already left could land on the file they were looking at — and nothing
   * re-read a file whose bytes had changed underneath the pane.
   *
   * Image and PDF panes read nothing here; their bytes ride the raw route the
   * download uses, and the read model refuses them as text on purpose.
   */
  const load = useCallback((): Promise<FileText> => (
    kind === "text" ? rpc<FileText>("readExecutorFile", [PLANE, path]) : Promise.resolve({})
  ), [kind, path, rpc]);
  const { resource, reload } = useAsyncResource(load, undefined, `${path}\u0000${revision}`);
  /** `null` IS the loading state: the body must never paint before the answer,
   *  or a reader (and the browser gate) sees an empty file that is not empty. */
  const file: FileText | null =
    resource.status === "ready" ? resource.value
    : resource.status === "error" ? { error: resource.message }
    : null;

  useEffect(() => {
    setDraft(null);
    setSaveError(null);
    setConflict(false);
    setAsSource(false);
  }, [path]);

  const save = useCallback(async (text: string) => {
    if (file?.revision === undefined) return;
    setSaving(true);
    setSaveError(null);
    setConflict(false);
    try {
      await putFileBytes(rawHref, text, file.revision);
      setDraft(null);
      reload();
      onSaved();
    } catch (error) {
      if (error instanceof FileWriteConflict) {
        setConflict(true);
        // Keep `draft`: a peer won the CAS, not this editor's text.
        reload();
      } else {
        setSaveError(renderThrownChain({ cause: error }));
      }
    } finally {
      setSaving(false);
    }
  }, [file?.revision, onSaved, rawHref, reload]);

  const content = file?.content ?? "";
  const editable = kind === "text" && fileTextEditable(file);

  return (
    <div
      data-files-preview
      className="absolute inset-0 z-10 p-bg flex flex-col border-l p-border @[64rem]:static @[64rem]:w-[42%] @[64rem]:shrink-0"
    >
      <div className="px-3 py-2 border-b p-border flex items-center gap-2 shrink-0">
        <FileIcon size={13} className="p-text-3 shrink-0" />
        <span className="text-xs font-mono p-text truncate" title={path}>{name}</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {draft === null && render !== "source" && (
            <button data-files-render-toggle onClick={() => setAsSource((s) => !s)}
              className="text-[11px] p-text-2 hover:p-text p-1"
              title={asSource ? `Show the rendered ${render === "markdown" ? "Markdown" : "page"}` : "Show the source"}
            >{asSource ? "Rendered" : "Source"}</button>
          )}
          {draft === null ? (
            editable && (
              <button data-files-edit onClick={() => setDraft(content)}
                className="flex items-center gap-1 text-[11px] p-text-2 hover:p-text p-1" title={`Edit ${name}`}>
                <PencilSimpleIcon size={12} />Edit
              </button>
            )
          ) : (
            <>
              <button data-files-save disabled={saving} onClick={() => void save(draft)}
                className="flex items-center gap-1 text-[11px] p-accent hover:underline p-1 disabled:opacity-50"
                title={`Save ${name}`}>
                <CheckIcon size={12} />{saving ? "Saving…" : "Save"}
              </button>
              <button onClick={() => { setDraft(null); setSaveError(null); }}
                className="text-[11px] p-text-3 hover:p-text p-1">Cancel</button>
            </>
          )}
          <a data-files-download href={downloadHref} className="flex items-center gap-1 text-[11px] p-text-2 hover:p-text p-1" title={`Download ${name}`}>
            <DownloadSimpleIcon size={12} />Download
          </a>
          <button onClick={onClose} className="p-text-3 hover:p-text p-1" title="Close preview" aria-label="Close preview">
            <XIcon size={13} />
          </button>
        </div>
      </div>
      {saveError && (
        <div className="px-3 py-1.5 text-xs p-danger border-b p-border flex items-start gap-1.5">
          <WarningIcon size={13} className="shrink-0 mt-px" />
          <span className="break-words min-w-0">{saveError}</span>
        </div>
      )}
      {conflict && (
        <div data-files-conflict className="px-3 py-1.5 text-xs p-danger border-b p-border flex items-start gap-2">
          <WarningIcon size={13} className="shrink-0 mt-px" />
          <span className="min-w-0 break-words">This file changed after you opened it. Your draft is still here.</span>
          <button type="button" onClick={() => {
            setDraft(null);
            setConflict(false);
            reload();
          }} className="ml-auto shrink-0 p-accent hover:underline">Reload newer content</button>
        </div>
      )}
      {kind === "text" && file?.readOnlyReason && draft === null && (
        <div className="px-3 py-1.5 text-[11px] p-text-4 border-b p-border">
          {file.readOnlyReason}
        </div>
      )}
      {kind === "text" && file?.truncated && draft === null && (
        <div className="px-3 py-1.5 text-[11px] p-text-4 border-b p-border">
          Preview truncated. Download the full file to edit it.
        </div>
      )}
      <div data-files-preview-body className="flex-1 min-h-0 overflow-auto">
        {kind === "image" && (
          <div className="h-full flex items-center justify-center p-4">
            <img src={rawHref} alt={name} className="max-w-full max-h-full object-contain rounded-sm border p-border" />
          </div>
        )}
        {kind === "pdf" && (
          <embed src={rawHref} type="application/pdf" className="w-full h-full" title={name} />
        )}
        {kind === "text" && (
          file === null ? <div className="h-full flex items-center justify-center"><Loader size="base" /></div>
          : file.error ? (
            <div className="p-4 text-xs space-y-2">
              <div className="p-danger break-words">{file.error}</div>
              <a href={downloadHref} className="inline-flex items-center gap-1 p-accent hover:underline">
                <DownloadSimpleIcon size={12} />Download instead
              </a>
            </div>
          ) : body === "edit" ? (
            <textarea
              data-files-editor
              autoFocus
              value={draft ?? ""}
              onChange={(e) => setDraft(e.currentTarget.value)}
              spellCheck={false}
              className="w-full h-full resize-none bg-transparent p-3 text-[11px] leading-relaxed font-mono p-text outline-hidden"
            />
          ) : body === "markdown" ? (
            <div className="p-3 text-xs p-text-2"><MarkdownContent content={content} /></div>
          ) : body === "html" ? (
            <iframe
              data-files-html-preview
              title={name}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={sandboxedHtml(content)}
              className="w-full h-full border-0 bg-white"
            />
          ) : (
            <pre className="p-3 text-[11px] leading-relaxed font-mono p-text-2 whitespace-pre-wrap break-words">
              {content}
              {file.truncated && <span className="p-text-4">{"\n… preview truncated. Download the full file."}</span>}
            </pre>
          )
        )}
      </div>
    </div>
  );
}
