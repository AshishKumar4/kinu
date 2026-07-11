/**
 * File-manager plumbing shared by the orchestrator RPCs and the FilesPane UI.
 *
 * One plane for BOTH read and write: every executor's files are reached
 * through the CompositeVFS. Workspace paths are composite-addressed already;
 * other executors' env-native paths map onto their mount prefix
 * (EXECUTOR_MOUNT_PREFIX), landing on the same raw handle the executor's tools
 * use — structured bytes and entries, never the executors' lossy LLM tool
 * strings. Unavailable mounts surface the composite's honest reservation error.
 */
import { EXECUTOR_MOUNT_PREFIX } from "@proteus/core";
import type { DirEntry } from "./protocol";

/**
 * Map an (executorId, environment-native path) to its CompositeVFS address.
 * The workspace executor IS the composite, so its paths pass through; every
 * other executor maps through its mount prefix. Returns null for an executor
 * with no file plane (unknown id).
 */
export function toCompositePath(executorId: string, path: string): string | null {
  if (executorId === "workspace") return path;
  const prefix = EXECUTOR_MOUNT_PREFIX[executorId];
  if (!prefix) return null;
  return `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
}

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

  const target = toCompositePath(executorId, path);
  if (target === null) return { error: `Executor "${executorId}" not found` };
  try {
    await deps.vfs.writeFile(target, bytes);
    return { ok: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Directories first, then files; alphabetical within each group. */
export function sortDirEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
