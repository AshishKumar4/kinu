/**
 * File-manager plumbing shared by the orchestrator RPCs and the FilesPane UI.
 *
 * Listing: normalize the heterogeneous `readdir` outputs of the execution
 * providers into a single typed DirEntry[]. Each provider returns a
 * different shape:
 *   - sandbox:  string  "d name\n- name\n…"        (type-prefixed)
 *   - nimbus:   string  "d name (123b)\n- name (45b)" (type-prefixed + size)
 *   - laptop:   string[] plain names (ls -1a)        (no type info)
 *   - workspace is read directly off the VFS by the orchestrator, not here.
 *
 * Writing: writeExecutorFileOp is the one upload seam — workspace writes go
 * binary-safe to the agent VFS, other executors route through their provider
 * writeFile tool (text-only transports), read-only executors get a typed error.
 */
import type { DirEntry } from "./protocol";

/** Per-file upload cap. Content crosses the agents RPC frame as base64, so the
 *  raw cap keeps the encoded payload within sane WS frame territory. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Strict base64 → bytes (throws on malformed input). */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Bytes → base64 without blowing the call stack on large files (UI side). */
export function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** What writeExecutorFileOp needs from the orchestrator — the workspace VFS
 *  (binary-safe, auto-creates parent dirs) and the provider lookup. */
export interface ExecutorWriteDeps {
  vfs: { writeFile(path: string, data: Uint8Array | string): Promise<void> };
  getProvider(executorId: string):
    | { tools: Record<string, { execute: (...args: unknown[]) => Promise<unknown> }> }
    | undefined
    | null;
}

export type ExecutorWriteResult = { ok: true } | { error: string };

/**
 * Write one uploaded file into an executor, mirroring readExecutorFile's
 * provider dispatch. Workspace → vfs.writeFile (binary-safe). Other executors →
 * their provider `writeFile` tool when present; those transports are
 * string-typed, so binary content is refused with a clear error rather than
 * silently corrupted. Executors with no writeFile tool are read-only.
 */
export async function writeExecutorFileOp(
  deps: ExecutorWriteDeps,
  executorId: string,
  path: string,
  contentBase64: string,
): Promise<ExecutorWriteResult> {
  if (!path || path.endsWith("/")) return { error: "file path required" };
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(contentBase64);
  } catch {
    return { error: "invalid base64 content" };
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return { error: `file too large (${bytes.length} bytes; max ${MAX_UPLOAD_BYTES})` };
  }

  if (executorId === "workspace") {
    await deps.vfs.writeFile(path, bytes);
    return { ok: true };
  }

  const provider = deps.getProvider(executorId);
  if (!provider) return { error: `Executor "${executorId}" not found` };
  const writeTool = provider.tools.writeFile;
  if (!writeTool) return { error: `Executor "${executorId}" is read-only — it has no writeFile tool` };
  if (bytes.includes(0)) {
    return { error: `binary upload is not supported on "${executorId}" — use the workspace executor` };
  }
  const result = await writeTool.execute(path, new TextDecoder().decode(bytes));
  // Provider writeFile tools report failures as strings ("writeFile error: …" /
  // "writeFile failed: …") instead of throwing — surface them as typed errors.
  if (typeof result === "string" && /^writeFile (error|failed)/i.test(result)) {
    return { error: result };
  }
  return { ok: true };
}

/** Strip a trailing slash (dir markers from some `ls` variants). */
function stripSlash(name: string): string {
  return name.endsWith("/") ? name.slice(0, -1) : name;
}

function parseLine(line: string): DirEntry | null {
  const s = line.trim();
  if (!s) return null;
  // "d name" / "- name", optionally with a " (123b)" size suffix (nimbus).
  const m = /^([d-])\s+(.+?)(?:\s+\((\d+)\s*b?\))?$/i.exec(s);
  if (m) {
    const name = stripSlash(m[2].trim());
    if (!name || name === "." || name === "..") return null;
    return { name, type: m[1] === "d" ? "dir" : "file", size: m[3] ? Number(m[3]) : undefined };
  }
  // Plain name (laptop) — a trailing slash is the only available dir hint.
  const isDir = s.endsWith("/");
  const name = stripSlash(s);
  if (!name || name === "." || name === "..") return null;
  return { name, type: isDir ? "dir" : "file" };
}

/** Directories first, then files; alphabetical within each group. */
export function sortDirEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Normalize a provider `readdir` result (string blob or string[]) → DirEntry[]. */
export function parseReaddirEntries(raw: unknown): DirEntry[] {
  const lines = Array.isArray(raw)
    ? (raw as unknown[]).map(String)
    : String(raw ?? "").split("\n");
  const entries: DirEntry[] = [];
  for (const line of lines) {
    const e = parseLine(line);
    if (e) entries.push(e);
  }
  return sortDirEntries(entries);
}
