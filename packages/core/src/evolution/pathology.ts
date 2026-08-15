/**
 * Failure pathologies — the named cells a scaffold proposal targets.
 *
 * Self-Harness's loop is mine-weaknesses → propose-minimal-edit → validate;
 * GSME keys its quality-diversity archive on (WHERE × WHY) pathology cells.
 * Proteus already mines (`turn_outcomes`) and validates (shadow + gates), but
 * the middle was untyped: proposals were free-form prose, so nothing could
 * say which failure a version was FOR, and nothing could notice the archive
 * piling into one failure mode while others went unexplored.
 *
 * Identity here is deterministic and model-free: a pathology id IS its
 * feature signature, `<complaint>/<responseMode>` — WHY the user pushed back ×
 * WHAT the agent had produced. The same failure therefore always lands in the
 * same cell, `describePathology` re-derives the human sentence from the id
 * alone (no label store, no join), and no model can rename a cell out from
 * under the archive that keys on it. `labelPathologyClusters` lets an LLM add
 * a nicer TITLE for the proposal prompt; it can never touch the id.
 *
 * Both vocabularies are closed and ordered, and classification is
 * first-match-wins, so clustering is a pure function of the outcome text.
 *
 * Pure by construction: no SQL, no clock, no runtime — the caller draws the
 * negative outcomes it wants clustered and passes them in.
 */

import * as v from 'valibot';
import type { LLM } from '../types/primitives.js';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured.js';
import type { JsonObject } from '../utils/json.js';

/** WHY the user pushed back. Ordered: the first match wins, so explicit
 *  lexical evidence outranks the inferred `repeat`, and `other` is the honest
 *  "a negative outcome with no legible complaint" cell rather than a guess. */
export const COMPLAINT_CLASSES = [
  'error', 'wrong_target', 'incomplete', 'no_action', 'overreach', 'repeat', 'other',
] as const;
export type ComplaintClass = (typeof COMPLAINT_CLASSES)[number];

/** WHAT the agent had produced when the user pushed back. Ordered the same
 *  way — a fenced answer is a code answer even if it also ends in a question. */
export const RESPONSE_MODES = ['code', 'question', 'prose', 'terse'] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];

const COMPLAINT_PATTERNS: ReadonlyArray<readonly [Exclude<ComplaintClass, 'repeat' | 'other'>, RegExp]> =
  Object.freeze([
    // `\w*errors?` so a named exception ("TypeError", "ValueError") reads as
    // the error report it is.
    ['error', /\b(\w*errors?|\w*exceptions?|traceback|stack ?trace|failed|failing|crash(ed|es)?|(does\s*n[o']?t|doesn't|did\s*n[o']?t|didn't|won'?t)\s+(work|run|compile|build)|broke|broken)\b/i],
    // No bare "i asked for": it reads as often in "more than I asked for"
    // (overreach) as in "I asked for X, not Y".
    ['wrong_target', /\b(not what i|that'?s not|thats not|i meant|wrong (file|one|thing|place|function)|other (file|one)|different (file|one))\b/i],
    // no_action before incomplete: "you didn't RUN it" is a loop that never
    // acted, "you didn't ADD the backoff" is a loop that stopped early. Both
    // start "you didn't", and only the verb tells them apart.
    ['no_action', /\b(nothing (happened|changed)|no changes?|you (just )?(said|described|explained|told me)|you (did\s*n[o']?t|didn't) (actually )?(run|execute|test|try|apply|do)|did you (actually )?(run|do|try)|without (running|doing))\b/i],
    ['incomplete', /\b(you (did\s*n[o']?t|didn't|forgot|missed|skipped)|still (missing|not|need)|only (did|added|changed)|what about|rest of (it|them|the)|half)\b/i],
    ['overreach', /\b(too (much|long|verbose|many)|did\s*n[o']?t ask (you )?(to|for)|unnecessar|over(kill|complicat)|i only (wanted|asked)|way more)\b/i],
  ] as const);

/** Content tokens for the `repeat` test — short words carry no topic. */
function contentTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []));
}

/** The follow-up re-states the original request: most of what the user first
 *  asked for is asked for again. Requires enough topic words on both sides to
 *  mean anything — a two-word request cannot be shown to have been repeated. */
function isRepeat(userMessage: string, followup: string): boolean {
  const asked = contentTokens(userMessage);
  if (asked.size < 3) return false;
  const again = contentTokens(followup);
  if (again.size < 3) return false;
  let shared = 0;
  for (const token of asked) if (again.has(token)) shared++;
  return shared / asked.size >= 0.5;
}

export function complaintClass(userMessage: string, followup: string | null): ComplaintClass {
  if (followup === null || followup.trim().length === 0) return 'other';
  for (const [complaint, pattern] of COMPLAINT_PATTERNS) {
    if (pattern.test(followup)) return complaint;
  }
  return isRepeat(userMessage, followup) ? 'repeat' : 'other';
}

/** Where "long" starts. A response past this is prose the user had to read
 *  rather than an answer they could act on. */
const PROSE_CHARS = 600;

export function classifyResponseMode(assistantResponse: string): ResponseMode {
  if (/```/.test(assistantResponse)) return 'code';
  const trimmed = assistantResponse.trimEnd();
  if (trimmed.endsWith('?')) return 'question';
  return trimmed.length > PROSE_CHARS ? 'prose' : 'terse';
}

/** The fields clustering reads off a negative turn outcome. `TurnOutcomeRow`
 *  satisfies it structurally — this module imports no ledger, so nothing here
 *  can drift into depending on how outcomes are stored. */
export interface PathologyInput {
  turnId: string | null;
  /** The recorded outcome kind. Not part of the cell id — severity is a
   *  statistic ABOUT a cell, not a different cell. */
  outcome: string;
  userMessage: string;
  assistantResponse: string;
  followup: string | null;
  scaffoldVersion: number | null;
}

/** One named failure cell, with the evidence behind it. */
export interface PathologyCluster {
  /** `<complaint>/<responseMode>` — deterministic, and the only identity. */
  id: string;
  complaint: ComplaintClass;
  responseMode: ResponseMode;
  /** Negative outcomes in this cell. */
  size: number;
  /** How many of them were the stronger `frustrated` signal. */
  frustrated: number;
  turnIds: string[];
  /** Scaffold versions that served turns in this cell, ascending. */
  scaffoldVersions: number[];
  /** Newest-first evidence, clamped for the prompt. */
  examples: ReadonlyArray<{ request: string; followup: string }>;
  /** Human title. Deterministic by default; an LLM may refine it. */
  title: string;
}

export function pathologyId(complaint: ComplaintClass, responseMode: ResponseMode): string {
  return `${complaint}/${responseMode}`;
}

interface ParsedPathologyId {
  complaint: ComplaintClass;
  responseMode: ResponseMode;
}

const ComplaintClassSchema = v.picklist(COMPLAINT_CLASSES);
const ResponseModeSchema = v.picklist(RESPONSE_MODES);

function parsePathologyId(id: string): ParsedPathologyId | null {
  const [complaint, responseMode, ...rest] = id.split('/');
  if (rest.length !== 0) return null;
  const parsedComplaint = v.safeParse(ComplaintClassSchema, complaint);
  const parsedResponseMode = v.safeParse(ResponseModeSchema, responseMode);
  if (!parsedComplaint.success || !parsedResponseMode.success) return null;
  return {
    complaint: parsedComplaint.output,
    responseMode: parsedResponseMode.output,
  };
}

/** True for a well-formed cell id — both halves drawn from the closed
 *  vocabularies. A proposal may legitimately name a cell nothing has landed
 *  in yet, so membership in the CURRENT clusters is not the test. */
export function isPathologyId(id: string): boolean {
  return parsePathologyId(id) !== null;
}

const COMPLAINT_PHRASE = {
  error: 'the user reported an error or that it did not work',
  wrong_target: 'the user said this was not what they asked for',
  incomplete: 'the user said the work was left unfinished',
  no_action: 'the user pointed out that nothing was actually done',
  overreach: 'the user said it did more than they asked for',
  repeat: 'the user had to re-state the same request',
  other: 'the user pushed back without a legible reason',
} satisfies Record<ComplaintClass, string>;

const MODE_PHRASE = {
  code: 'after a code answer',
  question: 'after a clarifying question',
  prose: 'after a long prose answer',
  terse: 'after a short answer',
} satisfies Record<ResponseMode, string>;

/**
 * The human sentence for a cell id. Derived from the id alone, so a stamped
 * `scaffold_versions.pathology` stays readable forever without a label store.
 * An unrecognized id renders as itself rather than as a fabricated sentence.
 */
export function describePathology(id: string): string {
  const parsed = parsePathologyId(id);
  if (!parsed) return id;
  return `${COMPLAINT_PHRASE[parsed.complaint]} ${MODE_PHRASE[parsed.responseMode]}`;
}

const EXAMPLE_CHARS = 160;

function clampExample(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXAMPLE_CHARS ? `${flat.slice(0, EXAMPLE_CHARS - 1)}…` : flat;
}

/**
 * Cluster negative turn outcomes into named cells, largest first (ties broken
 * by id, so the order is total and reproducible). `rows` should be the
 * corrected/frustrated outcomes — what counts as negative is the ledger's
 * definition, applied by the caller, not re-decided here.
 */
export function clusterPathologies(
  rows: ReadonlyArray<PathologyInput>,
  opts: { examples?: number } = {},
): PathologyCluster[] {
  const exampleCap = opts.examples ?? 2;
  const cells = new Map<string, PathologyCluster & { versions: Set<number> }>();

  for (const row of rows) {
    const complaint = complaintClass(row.userMessage, row.followup);
    const responseMode = classifyResponseMode(row.assistantResponse);
    const id = pathologyId(complaint, responseMode);
    let cell = cells.get(id);
    if (!cell) {
      cell = {
        id, complaint, responseMode, size: 0, frustrated: 0, turnIds: [],
        scaffoldVersions: [], examples: [], title: describePathology(id),
        versions: new Set<number>(),
      };
      cells.set(id, cell);
    }
    cell.size++;
    if (row.outcome === 'frustrated') cell.frustrated++;
    if (row.turnId !== null) cell.turnIds.push(row.turnId);
    if (row.scaffoldVersion !== null) cell.versions.add(row.scaffoldVersion);
    if (cell.examples.length < exampleCap) {
      cell.examples = [...cell.examples, {
        request: clampExample(row.userMessage),
        followup: clampExample(row.followup ?? ''),
      }];
    }
  }

  return [...cells.values()]
    .map(({ versions, ...cell }) => ({ ...cell, scaffoldVersions: [...versions].sort((a, b) => a - b) }))
    .sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));
}

export function buildPathologyLabelPrompt(clusters: ReadonlyArray<PathologyCluster>): string {
  const cells = clusters.map((c) =>
    `- ${c.id} (${c.size} turn${c.size === 1 ? '' : 's'}): ${describePathology(c.id)}\n` +
    c.examples.map((e) => `    asked: "${e.request}"\n    then said: "${e.followup}"`).join('\n'),
  );
  return (
    `These are clusters of turns that landed badly with the user, grouped by what ` +
    `the user complained about and what the assistant had produced.\n\n` +
    `${cells.join('\n')}\n\n` +
    `Give each cluster a short name (at most 8 words) describing the failure ` +
    `pattern an agentic loop would have to fix. Use the cluster ids as keys.\n` +
    `JSON response: {"<cluster id>":"<short name>"}\n` +
    jsonObjectOnlyInstruction()
  );
}

const TITLE_CHARS = 70;
const PathologyTitleSchema = v.pipe(v.string(), v.trim(), v.minLength(1));

/**
 * Refine cluster TITLES with one small LLM call. Identity, membership and
 * ordering are untouched — a model that fails, hallucinates ids, or returns
 * junk simply leaves the deterministic titles in place.
 */
export async function labelPathologyClusters(
  llm: LLM,
  clusters: ReadonlyArray<PathologyCluster>,
): Promise<PathologyCluster[]> {
  if (clusters.length === 0) return [];
  let titles: JsonObject;
  try {
    titles = extractJsonObject(await llm.complete(buildPathologyLabelPrompt(clusters)));
  } catch {
    return [...clusters];
  }
  return clusters.map((cluster) => {
    const title = v.safeParse(PathologyTitleSchema, titles[cluster.id]);
    if (!title.success) return cluster;
    return { ...cluster, title: title.output.slice(0, TITLE_CHARS) };
  });
}

/** How a proposal names the cell it targets: one tag line in the code it
 *  returns. A comment keeps the "return only JavaScript" contract intact, is
 *  inert in the sandbox, and travels with the scaffold source forever. */
const PATHOLOGY_TAG = /^[^\S\n]*\/\/[^\S\n]*pathology:[^\S\n]*(\S+)[^\S\n]*$/m;

export const PATHOLOGY_TAG_EXAMPLE = '// pathology: <id>';

/** The cell a proposal claims to target, or null when it named none or named
 *  something outside the closed vocabulary. */
export function parsePathologyTag(code: string): string | null {
  const tag = PATHOLOGY_TAG.exec(code)?.[1];
  return tag !== undefined && isPathologyId(tag) ? tag : null;
}

/** The prompt block: what keeps going wrong, and the ids to choose from. */
export function renderPathologyBlock(clusters: ReadonlyArray<PathologyCluster>): string {
  const lines = clusters.map((c) => {
    const severity = c.frustrated > 0 ? `, ${c.frustrated} frustrated` : '';
    const versions = c.scaffoldVersions.length > 0
      ? ` · seen on v${c.scaffoldVersions.join(', v')}`
      : '';
    const evidence = c.examples
      .map((e) => `      asked "${e.request}" → then "${e.followup}"`)
      .join('\n');
    return `  ${c.id} — ${c.title} (${c.size} turn${c.size === 1 ? '' : 's'}${severity})${versions}` +
      (evidence ? `\n${evidence}` : '');
  });
  return (
    `Failure pathologies mined from turns that landed badly with the user ` +
    `(id = what the user complained about / what you had produced):\n` +
    `${lines.join('\n')}\n\n`
  );
}
