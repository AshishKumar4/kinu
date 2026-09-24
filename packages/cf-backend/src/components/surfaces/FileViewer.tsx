/** Text rides the viewer RPC; images, PDFs and saves (PUT) ride the raw-bytes route. */
import { useCallback, useEffect, useState } from "react";
import { Loader } from "@cloudflare/kumo";
import {
  CheckIcon, DownloadSimpleIcon, FileIcon, PencilSimpleIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import { renderThrownChain } from "@kinu.run/core/obs";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { MarkdownContent, CodeBlock } from "./shared";
import {
  FileWriteConflict, fileTextEditable, putFileBytes, sandboxedHtml, textRenderOf, viewerKindOf,
  type FileText, type TextRender,
} from "@kinu.run/core";

export function FileViewer({ path, read, revision, rawHref, downloadHref, onSaved, onClose }: {
  path: string;
  /** An answer without a revision is read-only. */
  read: (path: string) => Promise<FileText>;
  /** A new value triggers a new read; that is the cache invalidation. */
  revision: string;
  rawHref: string;
  downloadHref: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const kind = viewerKindOf(path);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [asSource, setAsSource] = useState(false);

  const render = textRenderOf(path);
  const shownAs: TextRender = asSource ? "source" : render;
  const body: TextRender | "edit" = draft !== null ? "edit" : shownAs;

  /** `useAsyncResource` owns the generation, so a reply for a file the reader left cannot land on the current one. */
  const load = useCallback((): Promise<FileText> => (
    kind === "text" ? read(path) : Promise.resolve({})
  ), [kind, path, read]);

  const { resource, reload } = useAsyncResource(load, undefined, `${path}\u0000${revision}`);

  /** `null` is the loading state: never paint an empty body before the answer. */
  let file: FileText | null = null;

  if (resource.status === "ready") file = resource.value;
  else if (resource.status === "error") file = { error: resource.message };

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
              className="p-t-control p-text-2 hover:p-text p-1"
              title={asSource ? `Show the rendered ${render === "markdown" ? "Markdown" : "page"}` : "Show the source"}
            >{asSource ? "Rendered" : "Source"}</button>
          )}
          {draft === null ? (
            editable && (
              <button data-files-edit onClick={() => setDraft(content)}
                className="flex items-center gap-1 p-t-control p-text-2 hover:p-text p-1" title={`Edit ${name}`}>
                <PencilSimpleIcon size={12} />Edit
              </button>
            )
          ) : (
            <>
              <button data-files-save disabled={saving} onClick={() => void save(draft)}
                className="flex items-center gap-1 p-t-control p-accent hover:underline p-1 disabled:opacity-50"
                title={`Save ${name}`}>
                <CheckIcon size={12} />{saving ? "Saving…" : "Save"}
              </button>
              <button onClick={() => { setDraft(null); setSaveError(null); }}
                className="p-t-control p-text-3 hover:p-text p-1">Cancel</button>
            </>
          )}
          <a data-files-download href={downloadHref} className="flex items-center gap-1 p-t-control p-text-2 hover:p-text p-1" title={`Download ${name}`}>
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
        <div className="px-3 py-1.5 p-t-status p-text-4 border-b p-border">
          {file.readOnlyReason}
        </div>
      )}
      {kind === "text" && file?.truncated && draft === null && (
        <div className="px-3 py-1.5 p-t-status p-text-4 border-b p-border">
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
          <TextBody
            file={file}
            body={body}
            draft={draft}
            onDraft={setDraft}
            content={content}
            name={name}
            downloadHref={downloadHref}
          />
        )}
      </div>
    </div>
  );
}

function TextBody({ file, body, draft, onDraft, content, name, downloadHref }: {
  file: FileText | null;
  body: TextRender | "edit";
  draft: string | null;
  onDraft: (text: string) => void;
  content: string;
  name: string;
  downloadHref: string;
}) {
  if (file === null) return <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;

  if (file.error) {
    return (
      <div className="p-4 text-xs space-y-2">
        <div className="p-danger break-words">{file.error}</div>
        <a href={downloadHref} className="inline-flex items-center gap-1 p-accent hover:underline">
          <DownloadSimpleIcon size={12} />Download instead
        </a>
      </div>
    );
  }

  if (body === "edit") {
    return (
      <textarea
        data-files-editor
        autoFocus
        value={draft ?? ""}
        onChange={(e) => onDraft(e.currentTarget.value)}
        spellCheck={false}
        className="w-full h-full resize-none bg-transparent p-3 p-t-code p-text outline-hidden"
      />
    );
  }

  if (body === "markdown") return <div className="p-3 text-xs p-text-2"><MarkdownContent content={content} /></div>;

  if (body === "html") {
    return (
      <iframe
        data-files-html-preview
        title={name}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={sandboxedHtml(content)}
        className="w-full h-full border-0 bg-white"
      />
    );
  }

  return (
    <div className="px-3">
      <CodeBlock className={`language-${name.slice(name.lastIndexOf(".") + 1)}`}>{content}</CodeBlock>
      {file.truncated && <p className="text-xs p-text-4">… preview truncated. Download the full file.</p>}
    </div>
  );
}
