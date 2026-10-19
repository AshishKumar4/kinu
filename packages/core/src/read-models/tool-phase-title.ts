/**
 * A phase's line in a few words (the owner, 2026-10-19: "even smaller, cuz its about the phase"), read from its calls:
 * what they did, outcome first. A deploy, then the files edited, then the tests' count, then a commit, a helper hired,
 * the logs and files read, the web: the first of these, and a second only beside a short first. While the phase runs,
 * what is running now follows what it has done so far.
 *
 * A model may write the line instead, as the message's `kinuPhaseTitles`, keyed by the phase's first call; until one
 * lands, and wherever none does, the line is this one.
 */
import { getToolName } from "ai";
import * as v from "valibot";
import { describeToolCall } from "../tools/tool-call-summary";
import { JsonObjectSchema, type JsonObject } from "../utils/json";
import { andList } from "../utils/text";
import type { AnyToolPart } from "./tool-call-grouping";

/** What a phase's calls did, as its line can say it. */
interface PhaseFacts {
  readonly edited: string[];
  readonly read: string[];
  readonly hired: string[];
  readonly other: string[];
  logs: boolean;
  web: boolean;
  checked: boolean;
  committed: boolean;
  deployed: string | null;
  tests: { readonly passed: number | null; readonly failed: number | null; readonly ok: boolean } | null;
}

const InputSchema = v.looseObject({ op: v.optional(v.string()), path: v.optional(v.string()), name: v.optional(v.string()), command: v.optional(v.string()) });

/** A call's arguments as the row's describer reads them. */
function argsOf(part: AnyToolPart): JsonObject | undefined {
  const parsed = v.safeParse(JsonObjectSchema, part.input);

  return parsed.success ? parsed.output : undefined;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** A call's words as its row would show them: its output, or why it failed. */
function outputText(part: AnyToolPart): string {
  if (part.state === "output-error") return part.errorText;

  if (part.state !== "output-available") return "";

  return typeof part.output === "string" ? part.output : JSON.stringify(part.output);
}

function count(text: string, word: RegExp): number | null {
  const found = word.exec(text);

  return found?.[1] === undefined ? null : Number(found[1]);
}

/** The environment a deploy names, `--env staging`; none is production's. */
function deployTarget(command: string): string {
  return /--env[= ]([\w-]+)/.exec(command)?.[1] ?? "production";
}

/** A shell call by the phrase its row reads, so a command means one thing in the row and on the line. */
function noteCommand(facts: PhaseFacts, part: AnyToolPart, command: string): void {
  const said = describeToolCall(getToolName(part), argsOf(part));
  const text = outputText(part);

  if (said === "Ran tests") {
    const failed = count(text, /(\d+)\s+fail/i);

    facts.tests = { passed: count(text, /(\d+)\s+pass/i), failed, ok: part.state !== "output-error" && (failed ?? 0) === 0 };
  }
  else if (said === "Deployed") facts.deployed = deployTarget(command);
  else if (said === "Read the logs") facts.logs = true;
  else if (said === "Called an endpoint") facts.checked = true;
  else if (said === "Git commit") facts.committed = true;
  else if (said !== "" && said !== "Checked the deploy") facts.other.push(said);
}

function factsOf(calls: readonly AnyToolPart[]): PhaseFacts {
  const facts: PhaseFacts = { edited: [], read: [], hired: [], other: [], logs: false, web: false, checked: false, committed: false, deployed: null, tests: null };

  for (const part of calls) {
    const name = getToolName(part);
    const input = v.safeParse(InputSchema, part.input);
    const { op = "", path = "", command = "" } = input.success ? input.output : {};

    if (name === "file" && (op === "edit" || op === "write")) facts.edited.push(basename(path));
    else if (name === "file") facts.read.push(basename(path));
    else if (name === "web") facts.web = true;
    else if (name === "agents" && op === "hire" && input.success) facts.hired.push(input.output.name ?? "a helper");
    else if (name === "shell" || name === "run") noteCommand(facts, part, command);
    else facts.other.push(describeToolCall(name, argsOf(part)) || `used ${name}`);
  }

  return facts;
}

/** Each file once by its name, two at most; more as a count: "4 files". */
function fileNames(names: readonly string[]): string[] {
  const unique = [...new Set(names)];

  return unique.length <= 2 ? unique : [`${String(unique.length)} files`];
}

function files(names: readonly string[]): string {
  return andList(fileNames(names));
}

function testsClause(tests: NonNullable<PhaseFacts["tests"]>): string {
  if (!tests.ok) return tests.failed === null ? "tests failed" : `${String(tests.failed)} tests failed`;

  return tests.passed === null ? "tests pass" : `${String(tests.passed)} tests pass`;
}

/** Every clause the facts hold, the outcome first. */
function clauses(facts: PhaseFacts): string[] {
  const said: string[] = [];

  if (facts.deployed !== null) said.push(`deployed to ${facts.deployed}${facts.checked || facts.logs ? " and checked it" : ""}`);

  if (facts.edited.length > 0) said.push(`edited ${files(facts.edited)}`);

  if (facts.tests !== null) said.push(testsClause(facts.tests));

  if (facts.committed) said.push("committed");

  if (facts.hired.length > 0) said.push(`hired ${facts.hired.join(" and ")}`);

  if (facts.deployed === null && facts.logs) said.push(`read ${andList(["the logs", ...fileNames(facts.read)])}`);
  else if (facts.read.length > 0) said.push(`read ${files(facts.read)}`);

  if (facts.web) said.push("searched the web");

  if (facts.deployed === null && facts.checked) said.push("checked the endpoint");

  return [...said, ...facts.other.map((other) => other.charAt(0).toLowerCase() + other.slice(1))];
}

/** A first clause this short leaves room for a second. */
const SHORT_CLAUSE_WORDS = 4;

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What the calls did, in a few words; "" for none. */
export function phaseTitle(calls: readonly AnyToolPart[]): string {
  const [first, second] = clauses(factsOf(calls));

  if (first === undefined) return "";

  return capital(second !== undefined && first.split(" ").length < SHORT_CLAUSE_WORDS ? `${first}, ${second}` : first);
}

/** A row's past tense as the work going on: "Read db.ts" is "Reading db.ts". */
const ONGOING = new Map(Object.entries({
  Read: "Reading", Ran: "Running", Searched: "Searching", Fetched: "Fetching", Checked: "Checking", Deployed: "Deploying",
  Edited: "Editing", Wrote: "Writing", Called: "Calling", Hired: "Hiring", Inspected: "Inspecting", Changed: "Changing",
  Queried: "Querying", Built: "Building", Installed: "Installing", Typechecked: "Typechecking", Linted: "Linting",
  Formatted: "Formatting", Drove: "Driving", Listed: "Listing", Took: "Taking", Asked: "Asking", Messaged: "Messaging",
  Saved: "Saving", Recalled: "Recalling", Planned: "Planning", Updated: "Updating", Reported: "Reporting",
}));

/** What a running call is doing; "" when its arguments do not say. */
export function ongoing(part: AnyToolPart): string {
  const said = describeToolCall(getToolName(part), argsOf(part));
  const [verb = "", ...rest] = said.split(" ");
  const going = ONGOING.get(verb);

  if (said === "") return "";

  return going === undefined ? `Running ${said.charAt(0).toLowerCase()}${said.slice(1)}` : [going, ...rest].join(" ");
}

/** The lines a model wrote for a message's phases, by each phase's first call, and for the whole turn. */
export const PHASE_TITLES_METADATA_KEY = "kinuPhaseTitles";

export const TURN_TITLE_METADATA_KEY = "kinuTurnTitle";

const TitlesSchema = v.looseObject({
  [PHASE_TITLES_METADATA_KEY]: v.optional(v.record(v.string(), v.pipe(v.string(), v.trim(), v.nonEmpty()))),
  [TURN_TITLE_METADATA_KEY]: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
});

interface WrittenTitles {
  readonly phases: ReadonlyMap<string, string>;
  readonly turn: string | null;
}

export function writtenTitles(row: { metadata: unknown }): WrittenTitles {
  const parsed = v.safeParse(TitlesSchema, row.metadata);

  if (!parsed.success) return { phases: new Map(), turn: null };
  const { [PHASE_TITLES_METADATA_KEY]: phases = {}, [TURN_TITLE_METADATA_KEY]: turn = null } = parsed.output;

  return { phases: new Map(Object.entries(phases)), turn };
}
