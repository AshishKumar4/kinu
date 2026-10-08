/**
 * One-line tool-call summaries derived only from the call's arguments; empty when they say nothing.
 * Shared by the CLI and web chat.
 */
import { JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';
import { redactSecrets } from '../safety/secret-patterns';
import { NATIVE_ACTION_EFFECTS, type SlateMemberEffect } from '../slates/members';
import * as v from 'valibot';

/** Chip budget: must fit one line beside the name, runtime badge and duration. */
const MAX = 72;


function str(input: JsonObject, key: string): string {
  const value = input[key];

  return v.is(v.string(), value) ? value.trim() : "";
}

export type ToolCallEffect = 'read' | 'mutate' | 'unknown';

/** Only declared native operations are classified; shell and codemode programs have no effect receipt. */
export function toolCallEffect(toolName: string, input: JsonValue | undefined): ToolCallEffect {
  const parsed = v.safeParse(JsonObjectSchema, input);

  if (!parsed.success) return 'unknown';
  const op = str(parsed.output, 'op');
  const ops: Readonly<Record<string, SlateMemberEffect>> | undefined = Object.entries(NATIVE_ACTION_EFFECTS).find(([name]) => name === toolName)?.[1];

  return ops !== undefined && Object.hasOwn(ops, op) ? ops[op] : 'unknown';
}

/** Collapse whitespace and clip, marking the clip. */
export function clip(value: string, max: number = MAX): string {
  const flat = value.replace(/\s+/g, " ").trim();

  return flat.length <= max ? flat : `${flat.slice(0, max - 3).trimEnd()}...`;
}

function quoted(value: string, max: number = MAX): string {
  const clipped = clip(value, max);

  return clipped ? `"${clipped}"` : "";
}

function words(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" ");
}

/** `<action> <target> — "<body>"`, dropping whichever halves are absent. */
function actionOn(action: string, target?: string, body?: string): string {
  const head = words(action, target ? clip(target, 40) : undefined);
  const tail = body ? quoted(body, 48) : "";

  return tail ? `${head}: ${tail}` : head;
}

/** The first line of an eval program that isn't blank or a comment. */
function firstCodeLine(code: string): string {
  for (const raw of code.split("\n")) {
    const line = raw.trim();

    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;

    return line;
  }

  return "";
}

/** The first nonblank line is the model's user-facing codemode intent. */
function codemodeIntent(code: string): string {
  const first = code.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";

  return first.startsWith("//") ? clip(first.slice(2), 72) : "";
}

/** The delegation tool, by the operation its call names. */
function summarizeAgents(input: JsonObject): string {
  const op = str(input, "op");
  const agent = str(input, "agent");

  switch (op) {
    case "swarm": {
      const preset = str(input, "preset");
      const task = quoted(str(input, "task"), 56);
      const label = preset ? `swarm ${preset}` : "swarm";

      return task ? `${label}: ${task}` : label;
    }

    case "hire": {
      const name = str(input, "name");
      const role = str(input, "role");

      return actionOn(str(input, "lifetime") === "task" ? "hire (task)" : op, name || role, name ? role : "");
    }

    case "hireWorkspace": return actionOn("hire workspace", agent, str(input, "mission"));
    case "assign": return actionOn(op, agent, str(input, "message"));
    case "message": return actionOn(op, agent, str(input, "topic") || str(input, "message"));
    case "reply": return actionOn(op, undefined, str(input, "message"));
    default: return actionOn(op, agent);
  }
}

function summarizeMemory(input: JsonObject): string {
  const op = str(input, "op");

  if (op === "note") return actionOn(op, undefined, str(input, "content"));
  const key = str(input, "key");

  if (key) return actionOn(op, key);
  const query = str(input, "query");

  return query ? `${op} ${quoted(query, 56)}` : op;
}

/** Every operation reads by its path; an edit also reports its replacement count. */
function summarizeFile(input: JsonObject): string {
  const op = str(input, "op");
  const path = str(input, "path");
  const edits = input.edits;

  if (op === "edit" && Array.isArray(edits) && edits.length > 1) {
    return `${op} ${clip(path, 56)} (${edits.length} edits)`;
  }

  return path ? `${op} ${clip(path, 60)}` : op;
}

function summarizeWeb(input: JsonObject): string {
  const op = str(input, "op");
  const url = str(input, "url");

  if (url) return `${op} ${clip(url, 56)}`;
  const query = str(input, "query");

  return query ? `${op} ${quoted(query, 56)}` : op;
}

function summarizeTasks(input: JsonObject): string {
  const op = str(input, "op");

  if (op === "add") {
    const titles = Array.isArray(input.titles) ? input.titles.filter((title): title is string => v.is(v.string(), title)) : [];
    const parent = str(input, "parent");
    const head = titles.length > 1 ? `add ${titles.length} tasks` : "add";
    const target = parent ? `${head} under ${parent}` : head;

    return titles.length === 1 ? actionOn(target, undefined, titles[0]) : target;
  }

  if (op === "update") return actionOn(op, str(input, "id"), str(input, "status"));

  return op;
}

type ToolSummarizer = (input: JsonObject) => string;

const SUMMARIZERS = new Map<string, ToolSummarizer>(Object.entries({
  eval: (input) => clip(firstCodeLine(str(input, "code"))),
  shell: (input) => clip(str(input, "command")),
  file: summarizeFile,
  agents: summarizeAgents,
  memory: summarizeMemory,
  tasks: summarizeTasks,
  web: summarizeWeb,
  report: (input) => actionOn(str(input, "status"), undefined, str(input, "content")),
} satisfies Record<string, ToolSummarizer>));

/* What the call does, as opposed to what it was passed. Returns "" rather than guessing. */

/** Strip env assignments, `sudo`, and a leading path so `/usr/bin/git` and
 *  `FOO=1 sudo git` both reduce to `git`. */
function argv(command: string): string[] {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;

  while (i < parts.length && (/^[A-Z_][A-Z0-9_]*=/.test(parts[i]) || parts[i] === "sudo" || parts[i] === "env")) i++;
  const rest = parts.slice(i);

  if (rest.length > 0) {
    // `split` always yields at least one segment.
    const segments = rest[0].split("/");
    rest[0] = segments[segments.length - 1];
  }

  return rest;
}

/** Keyed on the word the agent typed, so a match is evidence rather than inference. */
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

export function describeCommand(command: string): string {
  const commandWords = argv(command);

  if (commandWords.length === 0) return "";

  // Keep the git verb; it is what the operator cares about.
  if (commandWords[0] === "git" && commandWords[1]) return `Git ${commandWords[1]}`;

  // Runners sit in front of the verb (`bunx wrangler deploy`); look only a few words in so paths don't decide.
  for (const word of commandWords.slice(0, 3)) {
    for (const [test, verb] of RUN_VERBS) if (test(word)) return verb;
  }

  return "";
}

const FILE_VERBS = new Map(Object.entries({
  read: "Read", write: "Wrote", edit: "Edited", list: "Listed", stat: "Checked", search: "Searched",
}));

const TASK_VERBS = new Map(Object.entries({
  add: "Planned the work", update: "Updated the task list", list: "Read the task list",
}));

const MEMORY_VERBS = new Map(Object.entries({
  note: "Saved to memory", remember: "Saved to memory", recall: "Recalled from memory", forget: "Forgot a memory", search: "Searched memory",
}));

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const segments = trimmed.split("/");
  const last = segments[segments.length - 1];

  // A path that is only separators has no segment to read; show what was given.
  return last === "" ? trimmed : last;
}

function describeWeb(input: JsonObject): string {
  if (str(input, "op") === "fetch") return "Fetched a page";

  if (str(input, "op") === "screenshot") return "Took a screenshot";

  return str(input, "query") ? "Searched the web" : "";
}

function describeAgents(input: JsonObject): string {
  const agent = str(input, "agent");

  switch (str(input, "op")) {
    case "swarm": {
      const preset = str(input, "preset");

      return preset ? `Ran a ${preset} search` : "Ran a search";
    }

    case "hire": {
      const name = str(input, "name");

      if (str(input, "lifetime") === "task") return name ? `Asked ${name} for one answer` : "Asked one agent for one answer";

      return name ? `Hired ${name}` : "Hired a subordinate";
    }

    case "hireWorkspace": return "Hired a workspace";
    case "assign":  return agent ? `Asked ${agent}` : "Asked a subordinate";
    case "message": return agent ? `Messaged ${agent}` : "Messaged an agent";
    case "reply":   return "Answered an agent message";
    case "dismiss": return agent ? `Dismissed ${agent}` : "Dismissed a subordinate";
    case "list":    return "Listed the roster";
    default:        return "";
  }
}

type ToolDescriber = (input: JsonObject) => string;

const DESCRIBERS = new Map<string, ToolDescriber>(Object.entries({
  shell: (input) => describeCommand(str(input, "command")),
  file: (input) => {
    const verb = FILE_VERBS.get(str(input, "op"));

    if (!verb) return "";
    const path = str(input, "path");

    return path ? `${verb} ${basename(path)}` : verb;
  },
  agents: describeAgents,
  memory: (input) => MEMORY_VERBS.get(str(input, "op")) ?? "",
  tasks: (input) => TASK_VERBS.get(str(input, "op")) ?? "",
  web: describeWeb,
  eval: (input) => codemodeIntent(str(input, "code")) || "Ran a tool program",
  report: (input) => (str(input, "status") ? `Reported ${str(input, "status")}` : "Reported back"),
} satisfies Record<string, ToolDescriber>));

/** Plain-English phrase for what a tool call does, from its arguments only; "" when they do not say. */
export function describeToolCall(toolName: string, input: JsonValue | undefined): string {
  const parsed = v.safeParse(JsonObjectSchema, input);

  if (!parsed.success) return "";

  const description = DESCRIBERS.get(toolName)?.(parsed.output) ?? "";

  // The chip previews the same call, so it gets the expanded card's redaction.
  return redactSecrets(description);
}


/** Unknown contract: a single string argument is shown as-is; anything else would be a guess. */
function summarizeUnknownTool(input: JsonObject): string {
  const strings = Object.values(input).filter((value): value is string =>
    v.is(v.string(), value) && value.trim().length > 0);

  return strings.length === 1 ? clip(strings[0] ?? '') : "";
}

/** One line describing a tool call from its arguments; "" when there is nothing worth showing. */
export function summarizeToolCall(toolName: string, input: JsonValue | undefined): string {
  const parsed = v.safeParse(JsonObjectSchema, input);

  if (!parsed.success) return "";
  const summarize = SUMMARIZERS.get(toolName);

  return redactSecrets(summarize ? summarize(parsed.output) : summarizeUnknownTool(parsed.output));
}
