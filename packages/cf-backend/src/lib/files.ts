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
 * Writing: writeExecutorFileOp is the one upload seam — every executor's
 * upload lands binary-safe through the CompositeVFS: workspace paths are
 * composite-addressed already; other executors' env-native paths map through
 * their mount prefix (EXECUTOR_MOUNT_PREFIX). Unavailable mounts surface the
 * composite's honest reservation error.
 */
import { EXECUTOR_MOUNT_PREFIX } from "@proteus/core";
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

/** What writeExecutorFileOp needs from the orchestrator — the workspace
 *  CompositeVFS (binary-safe on every mount). */
export interface ExecutorWriteDeps {
  vfs: { writeFile(path: string, data: Uint8Array | string): Promise<void> };
}

export type ExecutorWriteResult = { ok: true } | { error: string };

/**
 * Write one uploaded file into an executor — ONE binary-safe path: the
 * CompositeVFS. Workspace paths are composite-addressed already; other
 * executors' env-native paths map through their mount prefix, landing on the
 * same raw handle the executor's tools use. A reserved/offline mount yields
 * the composite's clear unavailability error.
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

  let target: string;
  if (executorId === "workspace") {
    target = path;
  } else {
    const prefix = EXECUTOR_MOUNT_PREFIX[executorId];
    if (!prefix) return { error: `Executor "${executorId}" not found` };
    target = `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
  }
  try {
    await deps.vfs.writeFile(target, bytes);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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
