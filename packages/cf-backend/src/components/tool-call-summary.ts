/**
 * Tool-call summary lines — the pure half of the chat's tool card.
 *
 * A bare `agents` chip repeated six times tells the operator nothing, and the
 * arguments the agent already passed say exactly what each call was about.
 * This turns those arguments into one compact line per call. It never invents
 * detail the arguments do not carry: when they say nothing the summary is
 * empty and the card falls back to the tool name alone.
 */

/** Chip budget — long enough for a command or a short task, short enough to
 *  stay on one line next to the name, runtime badge and duration. */
const MAX = 72;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function nested(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  return isRecord(value) ? value : {};
}

/** Collapse whitespace and clip, marking the clip so nothing reads as complete
 *  when it isn't. */
export function clip(value: string, max: number = MAX): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function quoted(value: string, max: number = MAX): string {
  const clipped = clip(value, max);
  return clipped ? `"${clipped}"` : "";
}

function words(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => !!p).join(" ");
}

/** `<action> <target> — "<body>"`, dropping whichever halves are absent. */
function actionOn(action: string, target?: string, body?: string): string {
  const head = words(action, target ? clip(target, 40) : undefined);
  const tail = body ? quoted(body, 48) : "";
  return tail ? `${head} — ${tail}` : head;
}

/** The first line of an execute_tools program that isn't blank or a comment —
 *  the expanded card shows the rest. */
function firstCodeLine(code: string): string {
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;
    return line;
  }
  return "";
}

function summarizeThink(input: Record<string, unknown>): string {
  const heads = Array.isArray(input.heads) ? input.heads.length : 0;
  const label = heads > 0 ? `${heads} heads` : str(input, "strategy");
  const task = quoted(str(input, "task"), 56);
  return [label, task].filter(Boolean).join(": ");
}

/** The unified delegation tool — one line per action, shaped like the
 *  summaries its three predecessors produced. */
function summarizeAgents(input: Record<string, unknown>): string {
  const action = str(input, "action");
  const agent = str(input, "agent");
  switch (action) {
    case "fork": {
      const forks = Array.isArray(input.forks) ? input.forks.length : 0;
      const settle = str(input, "settle");
      const label = [forks > 0 ? `${forks} forks` : "fork", settle && settle !== "merge" ? `settle=${settle}` : ""]
        .filter(Boolean).join(" ");
      const task = quoted(str(input, "task"), 56);
      return task ? `${label}: ${task}` : label;
    }
    case "staff":
      return str(input, "scope") === "workspace"
        ? actionOn("staff workspace", agent, str(input, "mission"))
        : actionOn(action, agent || str(input, "role"), agent ? str(input, "role") : "");
    case "ask":
    case "send":  return actionOn(action, agent, str(input, "topic") || str(input, "message"));
    case "reply": return actionOn(action, undefined, str(input, "message"));
    default:      return actionOn(action, agent);
  }
}

/** The unified durable-state tool — prose actions read by their content or
 *  query, keyed-fact actions by their key. */
function summarizeMemory(input: Record<string, unknown>): string {
  const action = str(input, "action");
  if (action === "save") return actionOn(action, undefined, str(input, "content"));
  const key = str(input, "key");
  if (key) return actionOn(action, key);
  const query = str(input, "query");
  return query ? `${action} ${quoted(query, 56)}` : action;
}

/** The file plane — every action reads by its path, and an edit says how many
 *  replacements it carried, which is the one thing the path does not tell you. */
function summarizeFile(input: Record<string, unknown>): string {
  const action = str(input, "action");
  const path = str(input, "path");
  const edits = input.edits;
  if (action === "edit" && Array.isArray(edits) && edits.length > 1) {
    return `${action} ${clip(path, 56)} (${edits.length} edits)`;
  }
  return path ? `${action} ${clip(path, 60)}` : action;
}

/** The unified web tool — a search reads by its query, a fetch by its url. */
function summarizeWeb(input: Record<string, unknown>): string {
  const action = str(input, "action");
  const url = str(input, "url");
  if (url) return `${action} ${clip(url, 56)}`;
  const query = str(input, "query");
  return query ? `${action} ${quoted(query, 56)}` : action;
}

function summarizeTeam(input: Record<string, unknown>): string {
  const action = str(input, "action");
  const name = str(input, "name");
  switch (action) {
    case "spawn":   return actionOn(action, name || str(input, "role"), name ? str(input, "role") : "");
    case "assign":  return actionOn(action, name, str(input, "task"));
    case "message": return actionOn(action, name, str(input, "content"));
    default:        return actionOn(action, name);
  }
}

function summarizePeers(input: Record<string, unknown>): string {
  const action = str(input, "action");
  const agent = str(input, "agent");
  switch (action) {
    case "ask":
    case "send":            return actionOn(action, agent, str(input, "topic") || str(input, "message"));
    case "reply":           return actionOn(action, undefined, str(input, "message"));
    case "spawn_workspace": return actionOn(action, agent, str(input, "purpose"));
    default:                return actionOn(action, agent);
  }
}

function summarizeRelease(input: Record<string, unknown>): string {
  const action = str(input, "action");
  const changeId = str(input, "changeId").slice(0, 8);
  switch (action) {
    case "create":
      return actionOn(action, undefined, str(input, "userPrompt"));
    case "bind_source": {
      const binding = nested(input, "binding");
      return actionOn(action, str(binding, "label") || str(binding, "kind"));
    }
    case "transition":
      return words(actionOn(action, changeId), str(input, "status") ? `→ ${str(input, "status")}` : undefined);
    case "record_check": {
      const check = nested(input, "check");
      return words(actionOn(action, str(check, "name") || changeId), str(check, "status") || undefined);
    }
    case "run_checks": {
      const checks = Array.isArray(input.checks) ? input.checks : [];
      const names = checks
        .map((c) => (isRecord(c) ? str(c, "name") : ""))
        .filter(Boolean)
        .join(", ");
      return names ? `${action} — ${clip(names, 48)}` : actionOn(action, changeId);
    }
    case "preview": {
      const port = typeof input.port === "number" ? `:${input.port}` : "";
      return words(actionOn(action, changeId), port || undefined);
    }
    case "deploy":
    case "rollback":
    case "record_deployment": {
      const environment = str(nested(input, "deployment"), "environment");
      return words(actionOn(action, changeId), environment || undefined);
    }
    case "request_approval":
      return words(actionOn(action, changeId), str(input, "approvalType") || undefined);
    default:
      return actionOn(action, changeId);
  }
}

const SUMMARIZERS: Record<string, (input: Record<string, unknown>) => string> = {
  execute_tools: (input) => clip(firstCodeLine(str(input, "code"))),
  run: (input) => clip(str(input, "command")),
  file: summarizeFile,
  skills: (input) => actionOn(str(input, "action"), str(input, "name")),
  agents: summarizeAgents,
  memory: summarizeMemory,
  web: summarizeWeb,
  // think/team/peers were unified into `agents`, fact into `memory`,
  // web_search/web_fetch into `web`, `experience` became an owner-driven
  // RPC rather than a tool, and `product_change` was renamed `release`;
  // their summarizers remain so tool calls in STORED transcripts keep
  // rendering under the name they were recorded with.
  think: summarizeThink,
  team: summarizeTeam,
  peers: summarizePeers,
  fact: (input) => actionOn(str(input, "action"), str(input, "key")),
  experience: (input) =>
    actionOn(str(input, "action"), str(input, "kind"), str(input, "query") || str(input, "key") || str(input, "id")),
  web_search: (input) => quoted(str(input, "query")),
  web_fetch: (input) => clip(str(input, "url")),
  report: (input) => actionOn(str(input, "status"), undefined, str(input, "content")),
  release: summarizeRelease,
  product_change: summarizeRelease,
};

/** MCP and crafted tools have no known argument contract. A single string
 *  argument IS the call's subject, so it can be shown as-is; anything else
 *  would be a guess. */
function summarizeUnknownTool(input: Record<string, unknown>): string {
  const strings = Object.values(input).filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return strings.length === 1 ? clip(strings[0]!) : "";
}

/**
 * One line describing what a tool call is doing, derived only from its
 * arguments. Empty when the arguments carry nothing worth showing (a bare
 * `agents({action:'list'})` still yields "list"; a call with no input yields "").
 */
export function summarizeToolCall(toolName: string, input: unknown): string {
  if (!isRecord(input)) return "";
  const summarize = SUMMARIZERS[toolName];
  return summarize ? summarize(input) : summarizeUnknownTool(input);
}
