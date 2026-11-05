/**
 * What this browser keeps for the app: a setting read and written through the page's own storage. A browser that
 * refuses storage (a sandboxed frame, site data blocked) keeps nothing: every read is a miss and every write is
 * dropped, so the page draws its defaults instead of failing on its first read.
 */
import { Result } from "effect";

export function readStored(key: string): string | null {
  return Result.getOrElse(Result.try(() => localStorage.getItem(key)), () => null);
}

/** `null` forgets the key. */
export function writeStored(key: string, value: string | null): void {
  Result.try(() => (value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value)));
}
