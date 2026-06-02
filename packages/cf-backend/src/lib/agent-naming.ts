// Agent naming — pure helpers shared by the browser create-flow and the server.
//
// Two distinct names: the URL-safe SLUG is the agent's stable Durable Object id
// (never shown as a title); the DISPLAY TITLE is what the roster/header show. A
// new agent gets a deterministic provisional title from its mission instantly,
// which the orchestrator later replaces with an AI-generated one on the first
// turn (see OrchestratorAgent.maybeGenerateTitle).

/** URL-safe slug for the Durable Object id (≤24 chars, no leading/trailing -). */
export function slugifyName(text: string): string {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

/** Deterministic provisional display title: the mission's first non-empty line,
 *  whitespace-collapsed, ≤60 chars. Empty string if the text has no content. */
export function deriveAgentTitle(text: string): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return firstLine.replace(/\s+/g, " ").slice(0, 60);
}

/** Roster title precedence when (re-)registering an agent: an explicit title
 *  wins (AI-titled re-sync); else keep any existing title (don't clobber on a
 *  title-less re-register); else a provisional from the mission; else the slug. */
export function resolveAgentTitle(opts: {
  explicit?: string; existing?: string; purpose?: string; slug: string;
}): string {
  return (opts.explicit && opts.explicit.trim())
    || (opts.existing && opts.existing.trim())
    || deriveAgentTitle(opts.purpose ?? "")
    || opts.slug;
}
