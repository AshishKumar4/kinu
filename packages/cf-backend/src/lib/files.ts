/**
 * Normalize the heterogeneous `readdir` outputs of the execution providers into
 * a single typed DirEntry[] for the file manager. Each provider returns a
 * different shape:
 *   - sandbox:  string  "d name\n- name\n…"        (type-prefixed)
 *   - nimbus:   string  "d name (123b)\n- name (45b)" (type-prefixed + size)
 *   - laptop:   string[] plain names (ls -1a)        (no type info)
 *   - workspace is read directly off the VFS by the orchestrator, not here.
 */
import type { DirEntry } from "./protocol";

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
