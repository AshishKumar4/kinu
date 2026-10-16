/**
 * The words sharing says, in one place so a part, a prompt and the Gallery name the same thing the same way. Hosted
 * only, so locked in `capability-parity.lock.json`: the local CLI has no slate to share.
 */
import type { GalleryCategory } from "@kinu.run/core";

export const CATEGORY_WORDS: Record<GalleryCategory, string> = { work: "Work", money: "Money", home: "Home", developer: "Developer", fun: "Fun" };

/** A grant's server as a sentence names it (`mcp.<server>`, `ai` or `web`): "github connection", "AI", "web access". */
export function serverWords(server: string): string {
  if (server === "ai") return "AI";

  if (server === "web") return "web access";

  return `${server.replace(/^mcp\./u, "")} connection`;
}

/** A grant's root, as "repo acme/site, branch main", or "everything" when it names none. */
export function rootWords(root: Readonly<Record<string, string>>): string {
  const parts = Object.entries(root).map(([key, value]) => `${key} ${value}`);

  return parts.length === 0 ? "everything it can reach" : parts.join(", ");
}
