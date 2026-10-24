/**
 * One-line tool-call summaries derived only from the call's arguments; empty when they say nothing.
 * Shared by the CLI and web chat.
 */
import { JsonObjectSchema, type JsonObject, type JsonValue } from '../utils/json';
import { redactSecrets } from '../safety/secret-patterns';
import { NATIVE_ACTION_EFFECTS, type ActionEffect } from '../slates/members';
import * as v from 'valibot';
import { oneLineClip } from '../utils/text';
import { programEffect, programEffectsOf } from '../execution/call-effects';
import { readShell } from '../safety/shell-reading';

/** The tool a program runs under. */
const EVAL_TOOL = 'eval';


/** Chip budget: must fit one line beside the name, runtime badge and duration. */
const MAX = 72;


function str(input: JsonObject, key: string): string {
  const value = input[key];

  return v.is(v.string(), value) ? value.trim() : "";
}

export type ToolCallEffect = 'read' | 'mutate' | 'unknown';

/**
 * Declared native operations are classified by their operation; a program by the record the host made of what it did
 * (`answered`: its call's id, and its output or error text). A shell command's own changes no record traces.
 */
export function toolCallEffect(toolName: string, input: JsonValue | undefined, answered?: { readonly toolCallId: string; readonly output: JsonValue | undefined }): ToolCallEffect {
  if (toolName === EVAL_TOOL && answered !== undefined) {
    const effects = programEffectsOf(answered.toolCallId, answered.output);

    // No record: made before programs were recorded, or failed before changing anything; either way not known.
    return effects === null ? 'unknown' : programEffect(effects);
  }

  const parsed = v.safeParse(JsonObjectSchema, input);

  if (!parsed.success) return 'unknown';
  const op = str(parsed.output, 'op');
  const ops: Readonly<Record<string, ActionEffect>> | undefined = Object.entries(NATIVE_ACTION_EFFECTS).find(([name]) => name === toolName)?.[1];

  return ops !== undefined && Object.hasOwn(ops, op) ? ops[op] : 'unknown';
}

/** Collapse whitespace and clip, marking the clip. */
function clip(value: string, max: number = MAX): string {
  return oneLineClip(value, max);
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

/** The first nonblank line is the model's user-facing codemode intent; "" when it declares none. */
export function programIntent(code: string): string {
  const first = code.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";

  return first.startsWith("//") ? redactSecrets(clip(first.slice(2), 72)) : "";
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

/** The line's first command's words as the shell reads them, its quotes undone and its assignments aside, past `sudo` and
 *  `env` and a leading path, so `/usr/bin/git` and `FOO="a b" sudo git` both reduce to `git`. None where no shell reads it. */
function argv(command: string): string[] {
  const parts = (readShell(command)?.pipelines[0]?.[0]?.[0]?.words ?? []).map((word) => word.text);
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

/** Keyed on the word the agent typed, so a match is evidence rather than inference. `program`: the word means this only
 *  as the program itself; as a later word it names something else (`wrangler tail` reads a Worker's logs). */
const RUN_VERBS: ReadonlyArray<readonly [test: (word: string) => boolean, verb: string, program?: true]> = [
  [(w) => w === "test" || w === "pytest" || w === "jest" || w === "vitest" || w === "mocha", "Ran tests"],
  [(w) => w === "typecheck" || w === "tsc", "Typechecked"],
  [(w) => w === "lint" || w === "eslint" || w === "ruff" || w === "clippy", "Linted"],
  [(w) => w === "fmt" || w === "format" || w === "prettier" || w === "gofmt", "Formatted"],
  [(w) => w === "build" || w === "make" || w === "compile", "Built"],
  [(w) => w === "install" || w === "add" || w === "ci" || w === "sync", "Installed dependencies"],
  [(w) => w === "deploy" || w === "publish", "Deployed"],
  [(w) => w === "curl" || w === "wget" || w === "http" || w === "httpie", "Called an endpoint"],
  [(w) => w === "grep" || w === "rg" || w === "ag" || w === "find" || w === "fd", "Searched the tree"],
  [(w) => w === "cat" || w === "head" || w === "tail" || w === "ls" || w === "wc" || w === "stat", "Inspected files", true],
  [(w) => w === "mkdir" || w === "cp" || w === "mv" || w === "rm" || w === "touch" || w === "chmod", "Changed files", true],
  [(w) => w === "docker" || w === "podman" || w === "kubectl", "Drove a container"],
  [(w) => w === "psql" || w === "sqlite3" || w === "mysql" || w === "redis-cli", "Queried a database"],
];

function describeCommand(command: string): string {
  const commandWords = argv(command);

  if (commandWords.length === 0) return "";

  // Keep the git verb; it is what the operator cares about.
  if (commandWords[0] === "git" && commandWords[1]) return `Git ${commandWords[1]}`;

  // Runners sit in front of the verb (`bunx wrangler deploy`); look only a few words in so paths don't decide.
  for (const [at, word] of commandWords.slice(0, 3).entries()) {
    // A tool's own `tail` or `logs` follows a service's output: `wrangler tail`, `docker logs`.
    if (at > 0 && (word === "tail" || word === "logs")) return "Read the logs";

    for (const [test, verb, program] of RUN_VERBS) {
      if (!test(word) || (program === true && at > 0)) continue;

      // A dry run uploads nothing.
      return verb === "Deployed" && commandWords.includes("--dry-run") ? "Checked the deploy" : verb;
    }
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

      return name ? `Hired ${name}` : "Hired a subagent";
    }

    case "hireWorkspace": return "Hired a workspace";
    case "assign":  return agent ? `Asked ${agent}` : "Asked a subagent";
    case "message": return agent ? `Messaged ${agent}` : "Messaged an agent";
    case "reply":   return "Answered an agent message";
    case "dismiss": return agent ? `Dismissed ${agent}` : "Dismissed a subagent";
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
  eval: (input) => programIntent(str(input, "code")) || "Ran a tool program",
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
