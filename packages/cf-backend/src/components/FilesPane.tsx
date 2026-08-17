/**
 * The ONE file browser. General per-executor file manager: typed directory
 * listing (getExecutorFiles) + a text viewer (readExecutorFile) + uploads via
 * drop or the Upload button. Listing and viewing ride the stable `rpc`, so the
 * pane only re-reads when the path or executor changes; uploads go over HTTP
 * (PUT /api/workspaces/<name>/files), because the RPC transport is the chat
 * WebSocket and its 1 MiB frame ceiling sits below ordinary file sizes.
 * The Environment surface points it at whichever environment is selected, so
 * every environment browses through this single entry point in ITS OWN native
 * paths. There is no shared address space to translate.
 *
 * WHERE IT OPENS, AND WHY THE PANE NEVER GUESSES
 *
 * The pane holds an ABSOLUTE path or nothing at all. It opens by asking for
 * nothing — `getExecutorFiles(exec, "")` — and the environment answers with the
 * directory it listed. Every move after that is arithmetic on a real path.
 *
 * That is the fix for "the parent directory doesn't work". Each environment
 * used to report its working directory as a literal `"."`, so the pane's own
 * breadcrumb split it into the single segment `["."]` and computed the parent
 * of `/home/user` as `/` — the filesystem root, two levels past where the
 * button said it would go, after which the `..` row disappeared entirely.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Loader } from "@cloudflare/kumo";
import {
  FolderIcon, FileIcon, ArrowsClockwiseIcon, ArrowLeftIcon, ArrowUpIcon,
  HouseIcon, WarningIcon, UploadSimpleIcon,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import type { Rpc } from "@/lib/protocol";
import { joinDir, parentDir, type DirEntry } from "@proteus/core";
import * as v from "valibot";

interface FileState { content?: string; truncated?: boolean; error?: string }
interface ExecutorDirectoryResponse { path?: string; entries?: DirEntry[]; error?: string }
const UploadErrorSchema = v.object({ error: v.optional(v.string()) });

/**
 * Sizes at a glance, in the unit that keeps the column scannable.
 *
 * Two significant figures under 10 and none above, so a directory of source
 * files reads `1.4k 12k 340k` rather than `1.4k 12.3k 339.7k` — the digits
 * past the first two are noise at this density, and the column stays narrow
 * enough that long filenames keep their width.
 */
function fmtSize(n: number): string {
  for (const [unit, scale] of [["M", 1024 ** 2], ["k", 1024]] as const) {
    if (n >= scale) {
      const value = n / scale;
      return `${value >= 10 ? Math.round(value) : value.toFixed(1)}${unit}`;
    }
  }
  return `${n}B`;
}

interface UploadState { name: string; status: "uploading" | "error"; error?: string }

export function FilesPane({ execName, rpc }: { execName: string; rpc: Rpc }) {
  // The workspace this pane's `rpc` is bound to — the upload route is
  // addressed by name, and it is the same workspace the route params name.
  const agentName = useParams().agentId ?? "";
  // Empty until the environment has told us where it starts. Never a relative
  // token: the only two states are "not asked yet" and a real absolute path.
  const [path, setPath] = useState("");
  const [home, setHome] = useState("");
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
      const r = await rpc<ExecutorDirectoryResponse>("getExecutorFiles", [execName, p]);
      if (r.error) { setErr(r.error); setEntries([]); return; }
      setEntries(r.entries ?? []);
      // The environment names the directory it listed. The first answer is
      // also this environment's home, which is what the Home button returns to.
      if (r.path !== undefined) {
        setPath(r.path);
        setHome((current) => current === "" ? r.path ?? "" : current);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setEntries([]); }
    finally { setLoading(false); }
  }, [rpc, execName]);

  const openFile = useCallback(async (full: string) => {
    setViewing(full);
    setFile(null);
    setFileLoading(true);
    try {
      setFile(await rpc<FileState>("readExecutorFile", [execName, full]));
    } catch (e) { setFile({ error: e instanceof Error ? e.message : String(e) }); }
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
        // Raw bytes over HTTP: no base64 inflation, no frame ceiling, no
        // app-level size cap — the workspace VFS chunks what it stores.
        const res = await fetch(
          `/api/workspaces/${encodeURIComponent(agentName)}/files`
          + `?executor=${encodeURIComponent(execName)}&path=${encodeURIComponent(joinDir(path, f.name))}`,
          { method: "PUT", body: f },
        );
        if (!res.ok) {
          const parsed = v.safeParse(UploadErrorSchema, await res.json().catch(() => null));
          const detail = parsed.success ? parsed.output.error : undefined;
          throw new Error(detail ?? `upload failed (${res.status})`);
        }
        setUploads((prev) => prev.filter((u) => u.name !== f.name));
      } catch (e) {
        setUploads((prev) => prev.map((u) => u.name === f.name
          ? { ...u, status: "error" as const, error: e instanceof Error ? e.message : String(e) }
          : u));
      }
    }
    await refresh(path);
  }, [agentName, execName, path, refresh]);

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

  const segments = path.split("/").filter(Boolean);
  const atRoot = path === "/" || path === "";
  const dirCount = entries.filter((e) => e.type === "dir").length;

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 border-b p-border flex items-center gap-1 text-xs font-mono">
        {/* The breadcrumb is the address AND the way up: every ancestor is a
            target, so "two levels up" is one click rather than two. */}
        <button data-files-crumb onClick={() => setPath("/")}
          className="p-text-3 hover:p-text shrink-0" title="Filesystem root">/</button>
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1 min-w-0">
            <button
              data-files-crumb
              onClick={() => setPath(`/${segments.slice(0, i + 1).join("/")}`)}
              className={`truncate ${i === segments.length - 1 ? "p-text" : "p-text-3 hover:p-text"}`}
            >{seg}</button>
            {i < segments.length - 1 && <span className="p-text-3 shrink-0">/</span>}
          </span>
        ))}
        <input ref={uploadInputRef} type="file" multiple className="hidden"
          onChange={(e) => { void uploadFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setPath(parentDir(path))}
            disabled={atRoot}
            className="p-text-3 hover:p-text p-1 disabled:opacity-30 disabled:hover:p-text-3"
            title="Parent directory" aria-label="Parent directory"
          ><ArrowUpIcon size={12} /></button>
          <button
            onClick={() => setPath(home)}
            disabled={home === "" || path === home}
            className="p-text-3 hover:p-text p-1 disabled:opacity-30 disabled:hover:p-text-3"
            title={home ? `Back to ${home}` : "Home"} aria-label="Home directory"
          ><HouseIcon size={12} /></button>
          <button
            onClick={() => uploadInputRef.current?.click()}
            className="flex items-center gap-1 p-text-3 hover:p-text p-1"
            title={`Upload files to ${path}`}
          ><UploadSimpleIcon size={11} />Upload</button>
          <button
            onClick={() => viewing ? openFile(viewing) : refresh(path)}
            className="p-text-3 hover:p-text p-1"
            title="Refresh" aria-label="Refresh"
          ><ArrowsClockwiseIcon size={11} /></button>
        </div>
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
          className={`flex-1 overflow-y-auto py-1 text-xs ${dragOver ? "outline-dashed outline-2 -outline-offset-2 outline-[var(--c-accent)]" : ""}`}
          onDragOver={onListDragOver} onDragLeave={onListDragLeave} onDrop={onListDrop}
        >
          {err && <div className="p-danger px-3 py-1.5 break-words">{err}</div>}
          {uploads.map((u) => (
            <div key={u.name} className="flex items-center gap-1.5 font-mono px-3 py-1">
              {u.status === "uploading"
                ? <><Loader size="sm" /><span className="p-text-2 truncate">{u.name}</span><span className="p-text-3">uploading…</span></>
                : <><WarningIcon size={12} className="p-danger shrink-0" /><span className="p-text-2 truncate">{u.name}</span><span className="p-danger truncate">{u.error}</span></>}
            </div>
          ))}
          {loading && <div className="p-text-3 px-3 py-1.5">Loading…</div>}
          {!loading && !atRoot && (
            <button
              data-files-up-row
              onClick={() => setPath(parentDir(path))}
              className="flex items-center gap-2 w-full text-left font-mono px-3 py-1 p-text-3 hover:p-text p-row-hover"
            ><ArrowUpIcon size={12} className="shrink-0" /><span>..</span></button>
          )}
          {entries.map((e) => (
            <button
              data-files-entry
              key={e.name}
              onClick={() => e.type === "dir" ? setPath(joinDir(path, e.name)) : openFile(joinDir(path, e.name))}
              // The full name is on the row's title: a pane this narrow will
              // clip long ones, and a tooltip is cheaper than a second line.
              className="flex items-center gap-2 w-full text-left font-mono px-3 py-1 p-text-2 hover:p-text p-row-hover"
              title={e.name}
            >
              {e.type === "dir"
                ? <FolderIcon size={12} className="p-info shrink-0" weight="fill" />
                : <FileIcon size={12} className="p-text-3 shrink-0" />}
              <span className="truncate flex-1">{e.name}</span>
              <span className="p-text-3 shrink-0 tabular-nums w-12 text-right">
                {e.type === "file" && e.size != null ? fmtSize(e.size) : ""}
              </span>
            </button>
          ))}
          {!loading && entries.length === 0 && !err && (
            <div className="p-text-3 italic px-3 py-1.5">This directory is empty. Drop files here to upload.</div>
          )}
          {/* A count, because "did it list everything?" is the question a long
              directory raises and scrolling to the bottom is a poor answer. */}
          {!loading && entries.length > 0 && (
            <div className="px-3 pt-1.5 pb-1 p-text-3 text-[10px] tabular-nums border-t p-border mt-1">
              {dirCount > 0 && `${dirCount} ${dirCount === 1 ? "directory" : "directories"}, `}
              {entries.length - dirCount} {entries.length - dirCount === 1 ? "file" : "files"}
            </div>
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
        {state?.truncated && <span className="text-[10px] px-1 rounded-sm p-fill p-text-3 ml-auto shrink-0">truncated</span>}
      </div>
      <div className="flex-1 overflow-auto">
        {loading ? <div className="p-text-3 text-xs px-3 py-3">Loading…</div>
          : state?.error ? <div className="p-danger text-xs px-3 py-3">{state.error}</div>
          : <pre className="text-[11px] font-mono p-text-2 whitespace-pre px-3 py-2 leading-relaxed">{state?.content ?? ""}</pre>}
      </div>
    </div>
  );
}
