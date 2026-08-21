/**
 * Tool-call summary lines — what a tool call is doing, from its arguments.
 *
 * A bare `agents` chip repeated six times tells the operator nothing, and the
 * arguments the agent already passed say exactly what each call was about.
 * This turns those arguments into one compact line per call. It never invents
 * detail the arguments do not carry: when they say nothing the summary is
 * empty and the caller falls back to the tool name alone.
 *
 * This lived in `cf-backend/src/components/` and was therefore a web-chat
 * capability, which is not what it is: nothing in it touches Cloudflare, React
 * or a DOM. The CLI, which renders the same tool calls to a terminal, had no
 * access to it and printed the raw argument VALUES joined with commas and
 * clipped at 70 characters — so `file({action:'edit', path, replacements})`
 * read as `edit, /a/b.ts, [{"old":"…` there and `Edited b.ts — 3 replacements`
 * on the web. One vocabulary, one home, both surfaces.
 */
import { isFailingToolResult } from '../orchestrator/turn-steering';
import { renderThrownChain } from '../obs/index';
import { JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue } from '../utils/json';
import * as v from 'valibot';

/** Chip budget — long enough for a command or a short task, short enough to
 *  stay on one line next to the name, runtime badge and duration. */
const MAX = 72;

/**
 * Whether a tool call is a failure, as the agent itself would read it — not
 * just as the transport does.
 *
 * The `run` tool (and every built-in) catches its own failure and RETURNS it
 * as an ordinary, successful result — `Error (exit 1)…` or `{"error": "…"}`
 * (execution/exec-result.ts, tools/builtins.ts) — because that text is what
 * steers the model's next step. A card that only checks the transport state
 * renders that exact case as a plain success: the curl that came back
 * `HTTP 500` looks identical to the one that came back `HTTP 200`. This reuses
 * the SAME predicate core's turn-steering already keys the agent's own
 * self-correction hints on, so the UI and the agent see failure the same way.
 */
export function isToolCallFailed<Input, Output>(
  toolName: string, input: Input, output: Output, protocolFailed: boolean,
): boolean {
  if (protocolFailed) return true;
  if (output == null) return false;
  const parsedOutput = v.safeParse(JsonValueSchema, output);
  if (!parsedOutput.success) return false;
  const result = v.is(v.string(), parsedOutput.output) ? parsedOutput.output : jsonOrString(parsedOutput.output);
  const parsedInput = v.safeParse(JsonObjectSchema, input);
  return isFailingToolResult({ toolName, args: parsedInput.success ? parsedInput.output : {}, result, success: true });
}

function jsonOrString(value: JsonValue): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return `unserializable tool call part: ${renderThrownChain({ cause: error })}`;
  }
}

function str(input: JsonObject, key: string): string {
  const value = input[key];
  return v.is(v.string(), value) ? value.trim() : "";
}

function nested(input: JsonObject, key: string): JsonObject {
  const value = input[key];
  return v.is(JsonObjectSchema, value) ? value : {};
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

function summarizeThink(input: JsonObject): string {
  const heads = Array.isArray(input.heads) ? input.heads.length : 0;
  const label = heads > 0 ? `${heads} heads` : str(input, "strategy");
  const task = quoted(str(input, "task"), 56);
  return [label, task].filter(Boolean).join(": ");
}

/** The unified delegation tool — one line per action, shaped like the
 *  summaries its three predecessors produced. `fork` is kept for the same
 *  reason `summarizeThink` is: this renders STORED calls, and a timeline written
 *  before the rung was removed must still read as what it was. */
function summarizeAgents(input: JsonObject): string {
  const action = str(input, "action");
  const agent = str(input, "agent");
  switch (action) {
    case "swarm": {
      const preset = str(input, "preset");
      const task = quoted(str(input, "task"), 56);
      const label = preset ? `swarm ${preset}` : "swarm";
      return task ? `${label}: ${task}` : label;
    }
    case "fork": {
      const forks = Array.isArray(input.forks) ? input.forks.length : 0;
      const label = forks > 0 ? `${forks} forks` : "fork";
      const task = quoted(str(input, "task"), 56);
      return task ? `${label}: ${task}` : label;
    }
    case "hire":
      return str(input, "scope") === "workspace"
        ? actionOn("hire workspace", agent, str(input, "mission"))
        : actionOn(action, agent || str(input, "role"), agent ? str(input, "role") : "");
    case "ask":
    case "send":  return actionOn(action, agent, str(input, "topic") || str(input, "message"));
    case "reply": return actionOn(action, undefined, str(input, "message"));
    default:      return actionOn(action, agent);
  }
}

/** The unified durable-state tool — prose actions read by their content or
 *  query, keyed-fact actions by their key. */
function summarizeMemory(input: JsonObject): string {
  const action = str(input, "action");
  if (action === "save") return actionOn(action, undefined, str(input, "content"));
  const key = str(input, "key");
  if (key) return actionOn(action, key);
  const query = str(input, "query");
  return query ? `${action} ${quoted(query, 56)}` : action;
}

/** The file plane — every action reads by its path, and an edit says how many
 *  replacements it carried, which is the one thing the path does not tell you. */
function summarizeFile(input: JsonObject): string {
  const action = str(input, "action");
  const path = str(input, "path");
  const edits = input.edits;
  if (action === "edit" && Array.isArray(edits) && edits.length > 1) {
    return `${action} ${clip(path, 56)} (${edits.length} edits)`;
  }
  return path ? `${action} ${clip(path, 60)}` : action;
}

/** The unified web tool — a search reads by its query, a fetch by its url. */
function summarizeWeb(input: JsonObject): string {
  const action = str(input, "action");
  const url = str(input, "url");
  if (url) return `${action} ${clip(url, 56)}`;
  const query = str(input, "query");
  return query ? `${action} ${quoted(query, 56)}` : action;
}

function summarizeTeam(input: JsonObject): string {
  const action = str(input, "action");
  const name = str(input, "name");
  switch (action) {
    case "spawn":   return actionOn(action, name || str(input, "role"), name ? str(input, "role") : "");
    case "assign":  return actionOn(action, name, str(input, "task"));
    case "message": return actionOn(action, name, str(input, "content"));
    default:        return actionOn(action, name);
  }
}

function summarizePeers(input: JsonObject): string {
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

/** The task list — an add reads by what it wrote, an update by which item it
 *  moved and where to. */
function summarizeTasks(input: JsonObject): string {
  const action = str(input, "action");
  if (action === "add") {
    const titles = Array.isArray(input.titles) ? input.titles.filter((title): title is string => v.is(v.string(), title)) : [];
    const parent = str(input, "parent");
    const head = titles.length > 1 ? `add ${titles.length} tasks` : "add";
    const target = parent ? `${head} under ${parent}` : head;
    return titles.length === 1 ? actionOn(target, undefined, titles[0]) : target;
  }
  if (action === "update") return actionOn(action, str(input, "id"), str(input, "status"));
  return action;
}

function summarizeRelease(input: JsonObject): string {
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
        .map((check) => (v.is(JsonObjectSchema, check) ? str(check, "name") : ""))
        .filter(Boolean)
        .join(", ");
      return names ? `${action} — ${clip(names, 48)}` : actionOn(action, changeId);
    }
    case "preview": {
      const port = v.is(v.number(), input.port) ? `:${input.port}` : "";
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

type ToolSummarizer = (input: JsonObject) => string;
const SUMMARIZERS = new Map<string, ToolSummarizer>(Object.entries({
  execute_tools: (input) => clip(firstCodeLine(str(input, "code"))),
  run: (input) => clip(str(input, "command")),
  file: summarizeFile,
  agents: summarizeAgents,
  memory: summarizeMemory,
  tasks: summarizeTasks,
  web: summarizeWeb,
  // think/team/peers were unified into `agents`, fact into `memory`,
  // web_search/web_fetch into `web`, `experience` became an owner-driven RPC
  // rather than a tool, `product_change` was renamed `release`, and `skills`
  // (list/invoke, both dead weight — invoke never restricted the turn that
  // called it) and `release` itself left the model's tool surface for
  // codemode/workspace.* reach; their summarizers remain so tool calls in
  // STORED transcripts keep rendering under the name they were recorded with.
  think: summarizeThink,
  team: summarizeTeam,
  peers: summarizePeers,
  fact: (input) => actionOn(str(input, "action"), str(input, "key")),
  experience: (input) =>
    actionOn(str(input, "action"), str(input, "kind"), str(input, "query") || str(input, "key") || str(input, "id")),
  web_search: (input) => quoted(str(input, "query")),
  web_fetch: (input) => clip(str(input, "url")),
  report: (input) => actionOn(str(input, "status"), undefined, str(input, "content")),
  skills: (input) => actionOn(str(input, "action"), str(input, "name")),
  release: summarizeRelease,
  product_change: summarizeRelease,
} satisfies Record<string, ToolSummarizer>));

/* ══════════════════════════════════════════════════════════════════════
   What the call DOES, as opposed to what it was passed.

   `run bun test packages/checkout` tells an operator what was typed. It
   does not tell them the agent is running tests, which is the thing they
   actually want to know while watching a turn go by. These functions read
   the real arguments and name the action; when the arguments do not say,
   they return "" and the row falls back to the tool name and the raw
   summary. Nothing here guesses.
   ══════════════════════════════════════════════════════════════════════ */

/** Strip env assignments, `sudo`, and a leading path so `/usr/bin/git` and
 *  `FOO=1 sudo git` both reduce to `git`. */
function argv(command: string): string[] {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < parts.length && (/^[A-Z_][A-Z0-9_]*=/.test(parts[i]!) || parts[i] === "sudo" || parts[i] === "env")) i++;
  const rest = parts.slice(i);
  if (rest.length > 0) rest[0] = rest[0]!.split("/").pop()!;
  return rest;
}

/** The verb each command word stands for. Keyed on the word the agent
 *  actually typed, so a match is evidence rather than inference. */
const RUN_VERBS: ReadonlyArray<readonly [test: (word: string) => boolean, verb: string]> = [
  [(w) => w === "test" || w === "pytest" || w === "jest" || w === "vitest" || w === "mocha", "Ran tests"],
  [(w) => w === "typecheck" || w === "tsc", "Typechecked"],
  [(w) => w === "lint" || w === "eslint" || w === "ruff" || w === "clippy", "Linted"],
  [(w) => w === "fmt" || w === "format" || w === "prettier" || w === "gofmt", "Formatted"],
  [(w) => w === "build" || w === "make" || w === "compile", "Built"],
  [(w) => w === "install" || w === "add" || w === "ci" || w === "sync", "Installed dependencies"],
  [(w) => w === "deploy" || w === "publish", "Deployed"],
  [(w) => w === "curl" || w === "wget" || w === "http" || w === "httpie", "Called an endpoint"],
  [(w) => w === "grep" || w === "rg" || w === "ag" || w === "find" || w === "fd", "Searched the tree"],
  [(w) => w === "cat" || w === "head" || w === "tail" || w === "ls" || w === "wc" || w === "stat", "Inspected files"],
  [(w) => w === "mkdir" || w === "cp" || w === "mv" || w === "rm" || w === "touch" || w === "chmod", "Changed files"],
  [(w) => w === "docker" || w === "podman" || w === "kubectl", "Drove a container"],
  [(w) => w === "psql" || w === "sqlite3" || w === "mysql" || w === "redis-cli", "Queried a database"],
];

/** What a shell command is for, from its own argv. */
export function describeCommand(command: string): string {
  const words = argv(command);
  if (words.length === 0) return "";
  // Every git verb reads fine as "Git <verb>", and flattening them all to one
  // phrase would lose the only thing the operator cares about.
  if (words[0] === "git" && words[1]) return `Git ${words[1]}`;
  // A runner and the tool it drives both sit in front of the verb
  // (`bunx wrangler deploy`, `npm run build`), so look a few words in — but
  // only a few, or a path argument starts deciding what the command was for.
  for (const word of words.slice(0, 3)) {
    for (const [test, verb] of RUN_VERBS) if (test(word)) return verb;
  }
  return "";
}

const FILE_VERBS = new Map(Object.entries({
  read: "Read", write: "Wrote", edit: "Edited", append: "Appended to",
  delete: "Deleted", list: "Listed", search: "Searched", move: "Moved", copy: "Copied",
}));

const TASK_VERBS = new Map(Object.entries({
  add: "Planned the work", update: "Updated the task list", list: "Read the task list",
}));

const MEMORY_VERBS = new Map(Object.entries({
  save: "Saved to memory", search: "Searched memory", get: "Recalled",
  set: "Recorded a fact", delete: "Forgot", list: "Listed memory",
}));

/** The last path segment — the part a person reads. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed;
}

function describeAgents(input: JsonObject): string {
  const action = str(input, "action");
  const agent = str(input, "agent");
  switch (action) {
    case "swarm": {
      const preset = str(input, "preset");
      return preset ? `Ran a ${preset} search` : "Ran a search";
    }
    // Stored history: the removed ephemeral rung still has to render.
    case "fork": {
      const forks = Array.isArray(input.forks) ? input.forks.length : 0;
      return forks > 0 ? `Delegated to ${forks} parallel ${forks === 1 ? "fork" : "forks"}` : "Delegated to a fork";
    }
    case "hire":
      return str(input, "scope") === "workspace"
        ? "Hired a workspace"
        : agent ? `Hired ${agent}` : "Hired a subordinate";
    case "ask":     return agent ? `Asked ${agent}` : "Asked a subordinate";
    case "send":    return agent ? `Messaged ${agent}` : "Messaged a subordinate";
    case "reply":   return "Replied to a subordinate";
    case "dismiss": return agent ? `Dismissed ${agent}` : "Dismissed a subordinate";
    case "list":    return "Listed the roster";
    case "status":  return agent ? `Checked on ${agent}` : "Checked the roster";
    default:        return "";
  }
}

type ToolDescriber = (input: JsonObject) => string;
const DESCRIBERS = new Map<string, ToolDescriber>(Object.entries({
  run: (input) => describeCommand(str(input, "command")),
  file: (input) => {
    const verb = FILE_VERBS.get(str(input, "action"));
    if (!verb) return "";
    const path = str(input, "path");
    return path ? `${verb} ${basename(path)}` : verb;
  },
  agents: describeAgents,
  memory: (input) => MEMORY_VERBS.get(str(input, "action")) ?? "",
  tasks: (input) => TASK_VERBS.get(str(input, "action")) ?? "",
  web: (input) => (str(input, "action") === "fetch" ? "Fetched a page" : str(input, "query") ? "Searched the web" : ""),
  web_search: () => "Searched the web",
  web_fetch: () => "Fetched a page",
  execute_tools: () => "Ran a tool program",
  think: (input) => {
    const heads = Array.isArray(input.heads) ? input.heads.length : 0;
    return heads > 0 ? `Explored with ${heads} heads` : "Explored the problem";
  },
  skills: (input) => (str(input, "action") === "run" ? "Ran a skill" : ""),
  release: (input) => {
    const action = str(input, "action");
    if (action === "create") return "Opened a change";
    if (action === "run_checks" || action === "record_check") return "Checked a change";
    if (action === "deploy") return "Deployed a change";
    if (action === "rollback") return "Rolled a change back";
    if (action === "request_approval") return "Asked you to approve";
    return "";
  },
  report: (input) => (str(input, "status") ? `Reported ${str(input, "status")}` : "Reported back"),
} satisfies Record<string, ToolDescriber>));

/**
 * A plain-English phrase for what a tool call is doing, derived only from
 * its arguments. Empty when the arguments do not say — the caller then
 * shows the tool name and the argument summary alone, which is the honest
 * fallback for an MCP or crafted tool whose contract we do not know.
 */
export function describeToolCall<Input>(toolName: string, input: Input): string {
  const parsed = v.safeParse(JsonObjectSchema, input);
  if (!parsed.success) return "";
  return DESCRIBERS.get(toolName)?.(parsed.output) ?? "";
}

/**
 * The headline for a collapsed run of consecutive calls: a tally of what the
 * agent did, in the order it first did each thing.
 *
 *   read, read, edit, write, fork  →  "5 calls · Read ×2 · Edited · Wrote · Delegated"
 *
 * The key is the verb from `describeToolCall`, so the line says what happened
 * rather than which tool was invoked. A call whose arguments carry no verb
 * falls back to its tool name, which is the most that can honestly be said
 * about an MCP tool nobody has a contract for.
 *
 * A tally rather than a sentence: a run mixes verbs, and five clauses joined
 * into prose reads worse at a glance than the counts do.
 */
export function summarizeToolRun<Input>(calls: ReadonlyArray<{ toolName: string; input: Input }>): string {
  const counts = new Map<string, number>();
  for (const { toolName, input } of calls) {
    const key = describeToolCall(toolName, input).split(" ")[0] || toolName;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const tally = [...counts].map(([verb, n]) => (n > 1 ? `${verb} ×${n}` : verb)).join(" · ");
  return `${calls.length} calls · ${tally}`;
}

/** MCP and crafted tools have no known argument contract. A single string
 *  argument IS the call's subject, so it can be shown as-is; anything else
 *  would be a guess. */
function summarizeUnknownTool(input: JsonObject): string {
  const strings = Object.values(input).filter((value): value is string =>
    v.is(v.string(), value) && value.trim().length > 0);
  return strings.length === 1 ? clip(strings[0] ?? '') : "";
}

/**
 * One line describing what a tool call is doing, derived only from its
 * arguments. Empty when the arguments carry nothing worth showing (a bare
 * `agents({action:'list'})` still yields "list"; a call with no input yields "").
 */
export function summarizeToolCall<Input>(toolName: string, input: Input): string {
  const parsed = v.safeParse(JsonObjectSchema, input);
  if (!parsed.success) return "";
  const summarize = SUMMARIZERS.get(toolName);
  return summarize ? summarize(parsed.output) : summarizeUnknownTool(parsed.output);
}
