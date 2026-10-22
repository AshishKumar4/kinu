/** Text rides the viewer RPC; images, PDFs and saves (PUT) ride the raw-bytes route. */
import { useCallback, useEffect, useState } from "react";
import { Loader } from "@/components/ui/Loader";
import {
  CheckIcon, DownloadSimpleIcon, FileIcon, PencilSimpleIcon, WarningIcon, XIcon,
} from "@phosphor-icons/react";
import { renderThrownChain } from "@kinu.run/core/obs";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { MarkdownContent, CodeBlock } from "./shared";
import {
  FileWriteConflict, fileTextEditable, MarkdownFrontmatterError, parseMarkdownFrontmatter, putFileBytes, sandboxedHtml, textRenderOf,
  viewerKindOf, type FileText, type TextRender,
} from "@kinu.run/core";
import { Button } from "@/components/ui/Button";
import { Surface } from "@/components/ui/Surface";
import { TextArea } from "@/components/ui/Field";

export function FileViewer({ path, read, revision, rawHref, downloadHref, onSaved, onClose }: {
  path: string;
  /** An answer without a revision is read-only. */
  read: (path: string) => Promise<FileText>;
  /** A new value triggers a new read; that is the cache invalidation. */
  revision: string;
  rawHref: string;
  downloadHref: string;
  onSaved?: () => void;
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
      onSaved?.();
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
    <Surface look="page" className="absolute inset-0 z-10 flex flex-col border-l p-border @[64rem]:static @[64rem]:w-[var(--layout-preview-pane)] @[64rem]:shrink-0" data-files-preview>
      <div className="px-3 py-2 border-b p-border flex items-center gap-2 shrink-0">
        <FileIcon size={13} className="p-text-3 shrink-0" />
        <span className="t-meta t-mono p-text truncate" title={path}>{name}</span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {draft === null && render !== "source" && (
            <Button variant="ghost" size="sm" data-files-render-toggle onClick={() => setAsSource((s) => !s)} title={asSource ? `Show the rendered ${render === "markdown" ? "Markdown" : "page"}` : "Show the source"}>{asSource ? "Rendered" : "Source"}</Button>
          )}
          {draft === null ? (
            editable && (
              <Button variant="ghost" size="sm" data-files-edit onClick={() => setDraft(content)} title={`Edit ${name}`} icon={<PencilSimpleIcon size={14} />}>Edit
              </Button>
            )
          ) : (
            <>
              <Button variant="ghost" size="sm" data-files-save disabled={saving} onClick={() => void save(draft)} title={`Save ${name}`}>
                <CheckIcon size={12} />{saving ? "Saving…" : "Save"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setSaveError(null); }}>Cancel</Button>
            </>
          )}
          <a data-files-download href={downloadHref} download={name} className="t-control flex items-center gap-1 p-text-2 hover:p-text p-1" title={`Download ${name}`}>
            <DownloadSimpleIcon size={12} />Download
          </a>
          <Button variant="ghost" size="sm" icon={<XIcon size={14} />} onClick={onClose} title="Close preview" aria-label="Close preview" />
        </div>
      </div>
      {saveError && (
        <div className="t-meta px-3 py-1 p-danger border-b p-border flex items-start gap-2">
          <WarningIcon size={13} className="shrink-0 mt-px" />
          <span className="break-words min-w-0">{saveError}</span>
        </div>
      )}
      {conflict && (
        <div data-files-conflict className="t-meta px-3 py-1 p-danger border-b p-border flex items-start gap-2">
          <WarningIcon size={13} className="shrink-0 mt-px" />
          <span className="min-w-0 break-words">This file changed after you opened it. Your draft is still here.</span>
          <Button variant="ghost" size="sm" className="ml-auto shrink-0" onClick={() => {
            setDraft(null);
            setConflict(false);
            reload();
          }}>Reload newer content</Button>
        </div>
      )}
      {kind === "text" && file?.readOnlyReason && draft === null && (
        <div className="t-status px-3 py-1 p-text-3 border-b p-border">
          {file.readOnlyReason}
        </div>
      )}
      {kind === "text" && file?.truncated && draft === null && (
        <div className="t-status px-3 py-1 p-text-3 border-b p-border">
          Preview truncated. Download the full file to edit it.
        </div>
      )}
      <div data-files-preview-body className="flex-1 min-h-0 overflow-auto">
        {kind === "image" && (
          <div className="h-full flex items-center justify-center p-4">
            <Surface look="outlined" as="img" className="max-w-full max-h-full object-contain" src={rawHref} alt={name} />
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
    </Surface>
  );
}

function frontmatterAsCode(markdown: string): string {
  let body: string;

  try {
    body = parseMarkdownFrontmatter(markdown).body;
  } catch (caught) {
    if (caught instanceof MarkdownFrontmatterError) return markdown;
    throw caught;
  }

  if (body.length === markdown.length) return markdown;
  const head = markdown.slice(0, markdown.length - body.length);

  return `\`\`\`yaml\n${head.slice(head.indexOf("\n") + 1, head.lastIndexOf("\n---"))}\n\`\`\`\n\n${body}`;
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
      <div className="t-meta p-4 space-y-2">
        <div className="p-danger break-words">{file.error}</div>
        <a href={downloadHref} download={name} className="inline-flex items-center gap-1 p-accent-fg hover:underline">
          <DownloadSimpleIcon size={12} />Download instead
        </a>
      </div>
    );
  }

  if (body === "edit") {
    return (
      <TextArea bare
        data-files-editor
        autoFocus
        value={draft ?? ""}
        onChange={(e) => onDraft(e.currentTarget.value)}
        spellCheck={false}
        className="t-code h-full p-3 p-text"
      />
    );
  }

  if (body === "markdown") return <div className="p-3 prose-chat"><MarkdownContent content={frontmatterAsCode(content)} /></div>;

  if (body === "html") {
    return (
      <Surface look="paper" as="iframe"
        data-files-html-preview
        title={name}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={sandboxedHtml(content)}
        className="w-full h-full border-0"
      />
    );
  }

  return (
    <div className="px-3">
      <CodeBlock className={`language-${name.slice(name.lastIndexOf(".") + 1)}`}>{content}</CodeBlock>
      {file.truncated && <p className="t-meta p-text-3">… preview truncated. Download the full file.</p>}
    </div>
  );
}
