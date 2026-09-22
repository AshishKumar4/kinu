/**
 * Failure pathologies: the cells a scaffold proposal targets. A pathology id is its
 * deterministic feature signature `<complaint>/<responseMode>`, so no model can rename
 * a cell; an LLM may only refine titles. Pure: callers pass the negative outcomes in.
 */

import * as v from 'valibot';
import type { LLM } from '../types/primitives';
import { extractJsonObject, jsonObjectOnlyInstruction } from '../prompts/structured';
import type { JsonObject } from '../utils/json';
import { diagnostics, renderThrownChain } from '../obs/index';

/** Ordered, first match wins: lexical evidence outranks the inferred `repeat`. */
export const COMPLAINT_CLASSES = [
  'error', 'wrong_target', 'incomplete', 'no_action', 'overreach', 'repeat', 'other',
] as const;

export type ComplaintClass = (typeof COMPLAINT_CLASSES)[number];

/** Ordered: a fenced answer is code even if it ends in a question. */
export const RESPONSE_MODES = ['code', 'question', 'prose', 'terse'] as const;

export type ResponseMode = (typeof RESPONSE_MODES)[number];

const COMPLAINT_PATTERNS: ReadonlyArray<readonly [Exclude<ComplaintClass, 'repeat' | 'other'>, RegExp]> =
  Object.freeze([
    ['error', /\b(\w*errors?|\w*exceptions?|traceback|stack ?trace|failed|failing|crash(ed|es)?|(does\s*n[o']?t|doesn't|did\s*n[o']?t|didn't|won'?t)\s+(work|run|compile|build)|broke|broken)\b/i],
    // No bare "i asked for": it appears as often in overreach ("more than I asked for").
    ['wrong_target', /\b(not what i|that'?s not|thats not|i meant|wrong (file|one|thing|place|function)|other (file|one)|different (file|one))\b/i],
    // Before incomplete: both start "you didn't"; only the verb tells them apart.
    ['no_action', /\b(nothing (happened|changed)|no changes?|you (just )?(said|described|explained|told me)|you (did\s*n[o']?t|didn't) (actually )?(run|execute|test|try|apply|do)|did you (actually )?(run|do|try)|without (running|doing))\b/i],
    ['incomplete', /\b(you (did\s*n[o']?t|didn't|forgot|missed|skipped)|still (missing|not|need)|only (did|added|changed)|what about|rest of (it|them|the)|half)\b/i],
    ['overreach', /\b(too (much|long|verbose|many)|did\s*n[o']?t ask (you )?(to|for)|unnecessar|over(kill|complicat)|i only (wanted|asked)|way more)\b/i],
  ] as const);

function contentTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []));
}

/** Most of the original request is asked for again; needs enough topic words on both sides. */
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

const PROSE_CHARS = 600;

export function classifyResponseMode(assistantResponse: string): ResponseMode {
  if (/```/.test(assistantResponse)) return 'code';
  const trimmed = assistantResponse.trimEnd();

  if (trimmed.endsWith('?')) return 'question';

  return trimmed.length > PROSE_CHARS ? 'prose' : 'terse';
}

/** `TurnOutcomeRow` satisfies it structurally; this module imports no ledger. */
export interface PathologyInput {
  turnId: string | null;
  /** Not part of the cell id: severity is a statistic about a cell. */
  outcome: string;
  userMessage: string;
  assistantResponse: string;
  followup: string | null;
  scaffoldVersion: number | null;
}

export interface PathologyCluster {
  /** The only identity. */
  id: string;
  complaint: ComplaintClass;
  responseMode: ResponseMode;
  size: number;
  frustrated: number;
  turnIds: string[];
  /** Ascending. */
  scaffoldVersions: number[];
  /** Newest first, clamped for the prompt. */
  examples: ReadonlyArray<{ request: string; followup: string }>;
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

/** Both halves from the closed vocabularies; a cell with no current cluster is still valid. */
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

/** Derived from the id alone; an unrecognized id renders as itself. */
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

/** Largest first, ties by id. `rows` should already be the negative outcomes. */
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

/** Refine titles with one LLM call; any failure leaves the deterministic titles. */
export async function labelPathologyClusters(
  llm: LLM,
  clusters: ReadonlyArray<PathologyCluster>,
): Promise<PathologyCluster[]> {
  if (clusters.length === 0) return [];
  let titles: JsonObject;

  try {
    titles = extractJsonObject(await llm.complete(buildPathologyLabelPrompt(clusters)));
  } catch (error) {
    diagnostics.event('pathology.label_degraded', { error: renderThrownChain({ cause: error }) });

    return [...clusters];
  }

  return clusters.map((cluster) => {
    const title = v.safeParse(PathologyTitleSchema, titles[cluster.id]);

    if (!title.success) return cluster;

    return { ...cluster, title: title.output.slice(0, TITLE_CHARS) };
  });
}

/** One tag line in the returned code; a comment keeps the "return only JavaScript" contract. */
const PATHOLOGY_TAG = /^[^\S\n]*\/\/[^\S\n]*pathology:[^\S\n]*(\S+)[^\S\n]*$/m;

export const PATHOLOGY_TAG_EXAMPLE = '// pathology: <id>';

/** Null when none was named or it lies outside the closed vocabulary. */
export function parsePathologyTag(code: string): string | null {
  const tag = PATHOLOGY_TAG.exec(code)?.[1];

  return tag !== undefined && isPathologyId(tag) ? tag : null;
}

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
