/**
 * The ONE file browser. General per-executor file manager: typed directory
 * listing (getExecutorFiles) + a text viewer (readExecutorFile) + uploads
 * (writeExecutorFile) via drop or the Upload button. Drives its own fetches
 * off the stable `rpc`, so it only re-reads when the path or executor changes.
 * The Environment surface mounts it over the CompositeVFS (execName
 * "workspace", initialPath at a mount prefix), so /local, /sandbox, /nimbus
 * and /pc all browse through this single entry point.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Loader } from "@cloudflare/kumo";
import {
  FolderIcon, FileIcon, ArrowsClockwiseIcon, ArrowLeftIcon,
  WarningIcon, UploadSimpleIcon,
} from "@phosphor-icons/react";
import type { DirEntry, Rpc } from "@/lib/protocol";
import { MAX_UPLOAD_BYTES, encodeBase64 } from "@/lib/files";

interface FileState { content?: string; truncated?: boolean; error?: string }

function fmtSize(n: number): string {
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}k`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

interface UploadState { name: string; status: "uploading" | "error"; error?: string }

export function FilesPane({ execName, rpc, initialPath = "/" }: { execName: string; rpc: Rpc; initialPath?: string }) {
  const [path, setPath] = useState(initialPath);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);   // full path of file in the viewer
  const [file, setFile] = useState<FileState | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (p: string) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await rpc("getExecutorFiles", [execName, p]) as { entries?: DirEntry[]; error?: string };
      if (r.error) { setErr(r.error); setEntries([]); }
      else setEntries(r.entries ?? []);
    } catch (e) { setErr((e as Error).message); setEntries([]); }
    finally { setLoading(false); }
  }, [rpc, execName]);

  const openFile = useCallback(async (full: string) => {
    setViewing(full);
    setFile(null);
    setFileLoading(true);
    try {
      setFile(await rpc("readExecutorFile", [execName, full]) as FileState);
    } catch (e) { setFile({ error: (e as Error).message }); }
    finally { setFileLoading(false); }
  }, [rpc, execName]);

  // Re-list on path/executor change; leaving any open file viewer.
  useEffect(() => { setViewing(null); refresh(path); }, [path, execName, refresh]);

  // Sequential per-file upload into the current directory; failed files stay
  // listed with their error until the next upload batch replaces them.
  const uploadFiles = useCallback(async (files: FileList | null | undefined) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setUploads(list.map((f) => ({ name: f.name, status: "uploading" as const })));
    for (const f of list) {
      try {
        if (f.size > MAX_UPLOAD_BYTES) throw new Error(`too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB)`);
        const b64 = encodeBase64(new Uint8Array(await f.arrayBuffer()));
        const r = await rpc("writeExecutorFile", [execName, joinPath(path, f.name), b64]) as { ok?: true; error?: string };
        if (r.error) throw new Error(r.error);
        setUploads((prev) => prev.filter((u) => u.name !== f.name));
      } catch (e) {
        setUploads((prev) => prev.map((u) => u.name === f.name
          ? { ...u, status: "error" as const, error: e instanceof Error ? e.message : String(e) }
          : u));
      }
    }
    await refresh(path);
  }, [rpc, execName, path, refresh]);

  const onListDragOver = useCallback((e: ReactDragEvent) => {
    if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); }
  }, []);
  const onListDragLeave = useCallback((e: ReactDragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  }, []);
  const onListDrop = useCallback((e: ReactDragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragOver(false);
    void uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  const segments = path === "/" ? [] : path.split("/").filter(Boolean);

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b p-border flex items-center gap-1 text-xs font-mono">
        <button onClick={() => setPath("/")} className="p-text-2 hover:p-text">/</button>
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            <button
              onClick={() => setPath('/' + segments.slice(0, i + 1).join('/'))}
              className="p-text-2 hover:p-text"
            >{seg}</button>
            {i < segments.length - 1 && <span className="p-text-3">/</span>}
          </span>
        ))}
        <input ref={uploadInputRef} type="file" multiple className="hidden"
          onChange={(e) => { void uploadFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
        <button
          onClick={() => uploadInputRef.current?.click()}
          className="ml-auto flex items-center gap-1 p-text-3 hover:p-text p-1"
          title={`Upload files to ${path}`}
        ><UploadSimpleIcon size={11} />Upload</button>
        <button
          onClick={() => viewing ? openFile(viewing) : refresh(path)}
          className="p-text-3 hover:p-text p-1"
          title="Refresh"
        ><ArrowsClockwiseIcon size={11} /></button>
      </div>

      {viewing ? (
        <FileViewer
          name={viewing.split("/").pop() ?? viewing}
          state={file}
          loading={fileLoading}
          onBack={() => setViewing(null)}
        />
      ) : (
        <div
          className={`flex-1 overflow-y-auto px-3 py-2 text-xs space-y-0.5 ${dragOver ? "outline-dashed outline-2 -outline-offset-2 outline-[var(--c-accent)]" : ""}`}
          onDragOver={onListDragOver} onDragLeave={onListDragLeave} onDrop={onListDrop}
        >
          {err && <div className="p-danger">{err}</div>}
          {uploads.map((u) => (
            <div key={u.name} className="flex items-center gap-1.5 font-mono">
              {u.status === "uploading"
                ? <><Loader size="sm" /><span className="p-text-2 truncate">{u.name}</span><span className="p-text-3">uploading…</span></>
                : <><WarningIcon size={12} className="p-danger shrink-0" /><span className="p-text-2 truncate">{u.name}</span><span className="p-danger truncate">{u.error}</span></>}
            </div>
          ))}
          {loading && <div className="p-text-3">Loading…</div>}
          {!loading && segments.length > 0 && (
            <button
              onClick={() => setPath('/' + segments.slice(0, -1).join('/'))}
              className="flex items-center gap-1.5 p-text-3 hover:p-text font-mono"
            ><FolderIcon size={12} /> ..</button>
          )}
          {entries.map((e) => (
            <button
              key={e.name}
              onClick={() => e.type === "dir" ? setPath(joinPath(path, e.name)) : openFile(joinPath(path, e.name))}
              className="flex items-center gap-1.5 w-full text-left font-mono p-text-2 hover:p-text"
            >
              {e.type === "dir"
                ? <FolderIcon size={12} className="p-info shrink-0" weight="fill" />
                : <FileIcon size={12} className="p-text-3 shrink-0" />}
              <span className="truncate flex-1">{e.name}</span>
              {e.type === "file" && e.size != null && <span className="p-text-3 shrink-0 tabular-nums">{fmtSize(e.size)}</span>}
            </button>
          ))}
          {!loading && entries.length === 0 && !err && (
            <div className="p-text-3 italic">(empty)</div>
          )}
        </div>
      )}
    </div>
  );
}

function FileViewer({ name, state, loading, onBack }: {
  name: string; state: FileState | null; loading: boolean; onBack: () => void;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b p-border">
        <button onClick={onBack} className="p-text-3 hover:p-text" title="Back to files" aria-label="Back to files">
          <ArrowLeftIcon size={12} />
        </button>
        <span className="text-xs font-mono p-text-2 truncate">{name}</span>
        {state?.truncated && <span className="text-[10px] px-1 rounded p-elevated p-text-3 ml-auto shrink-0">truncated</span>}
      </div>
      <div className="flex-1 overflow-auto">
        {loading ? <div className="p-text-3 text-xs px-3 py-3">Loading…</div>
          : state?.error ? <div className="p-danger text-xs px-3 py-3">{state.error}</div>
          : <pre className="text-[11px] font-mono p-text-2 whitespace-pre px-3 py-2 leading-relaxed">{state?.content ?? ""}</pre>}
      </div>
    </div>
  );
}
