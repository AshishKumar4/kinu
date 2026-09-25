/**
 * Read-only miner of Claude Code transcripts (`~/.claude/projects/<cwd>/<session>.jsonl`) into corpus turns.
 * The file is a DAG: walk the live path back via `parentUuid`, never line order. Schema drifts across CLI versions,
 * so unreadable input is skipped and counted in `MineSkips`. Sidechain and non-interactive sessions are dropped.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  EVIDENCE_BUDGETS, evidenceWindow, isTrivialTurn,
  JsonArraySchema, JsonObjectSchema, JsonValueSchema, parseJsonValue,
  type CorpusTurn, type JsonObject, type JsonValue, type ToolCallRecord,
} from '@kinu.run/core';
import { classify, tolerate } from '@kinu.run/core/obs';
import * as v from 'valibot';

export function defaultTranscriptRoot(home: string): string {
  return join(home, '.claude', 'projects');
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: JsonObject;
  content?: JsonValue;
  is_error?: boolean;
}

interface Entry {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  entrypoint?: string;
  sessionKind?: string;
  version?: string;
  timestamp?: string;
  interruptedMessageId?: string;
  toolDenialKind?: string;
  message?: { role?: string; content?: JsonValue };
}

function normalizedEntry(input: { value: JsonValue }): Entry | null {
  const record = v.safeParse(JsonObjectSchema, input.value);

  if (!record.success) return null;
  const entry: Entry = {};
  const type = stringValue(record.output.type);
  const uuid = stringValue(record.output.uuid);
  const parentUuid = stringValue(record.output.parentUuid);
  const entrypoint = stringValue(record.output.entrypoint);
  const sessionKind = stringValue(record.output.sessionKind);
  const version = stringValue(record.output.version);
  const timestamp = stringValue(record.output.timestamp);
  const interruptedMessageId = stringValue(record.output.interruptedMessageId);
  const toolDenialKind = stringValue(record.output.toolDenialKind);
  const isSidechain = booleanValue(record.output.isSidechain);
  const isMeta = booleanValue(record.output.isMeta);
  const isCompactSummary = booleanValue(record.output.isCompactSummary);

  if (type !== undefined) entry.type = type;

  if (uuid !== undefined) entry.uuid = uuid;

  if (parentUuid !== undefined) entry.parentUuid = parentUuid;

  if (entrypoint !== undefined) entry.entrypoint = entrypoint;

  if (sessionKind !== undefined) entry.sessionKind = sessionKind;

  if (version !== undefined) entry.version = version;

  if (timestamp !== undefined) entry.timestamp = timestamp;

  if (interruptedMessageId !== undefined) entry.interruptedMessageId = interruptedMessageId;

  if (toolDenialKind !== undefined) entry.toolDenialKind = toolDenialKind;

  if (isSidechain !== undefined) entry.isSidechain = isSidechain;

  if (isMeta !== undefined) entry.isMeta = isMeta;

  if (isCompactSummary !== undefined) entry.isCompactSummary = isCompactSummary;
  const message = v.safeParse(JsonObjectSchema, record.output.message);

  if (message.success) {
    const normalizedMessage: Entry['message'] = {};
    const role = stringValue(message.output.role);

    if (role !== undefined) normalizedMessage.role = role;
    const content = v.safeParse(v.optional(JsonValueSchema), message.output.content);

    if (content.success && content.output !== undefined) normalizedMessage.content = content.output;
    entry.message = normalizedMessage;
  }

  return entry;
}

function normalizedBlock(input: { value: JsonValue }): ContentBlock | null {
  const record = v.safeParse(JsonObjectSchema, input.value);

  if (!record.success) return null;
  const block: ContentBlock = {};
  const type = stringValue(record.output.type);
  const text = stringValue(record.output.text);
  const name = stringValue(record.output.name);
  const isError = booleanValue(record.output.is_error);

  if (type !== undefined) block.type = type;

  if (text !== undefined) block.text = text;

  if (name !== undefined) block.name = name;

  if (isError !== undefined) block.is_error = isError;
  const parsedInput = v.safeParse(JsonObjectSchema, record.output.input);

  if (parsedInput.success) block.input = parsedInput.output;
  const content = v.safeParse(v.optional(JsonValueSchema), record.output.content);

  if (content.success && content.output !== undefined) block.content = content.output;

  return block;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  const parsed = v.safeParse(v.string(), value);

  return parsed.success ? parsed.output : undefined;
}

function booleanValue(value: JsonValue | undefined): boolean | undefined {
  const parsed = v.safeParse(v.boolean(), value);

  return parsed.success ? parsed.output : undefined;
}

/** Tool results carry either a bare string or an array of text blocks. */
function blockText(value: JsonValue | undefined): string {
  const text = v.safeParse(v.string(), value);

  if (text.success) return text.output;
  const parts = v.safeParse(JsonArraySchema, value);

  if (!parts.success) return '';

  return parts.output.map((part) => normalizedBlock({ value: part })?.text ?? '').join('');
}

/** User-role entries that are not the user typing: CLI wrappers, slash-command echoes, notices. Anchored
 *  at the start because each is a prefix the CLI prepends. */
const SYNTHETIC_PROMPT = new RegExp('^\\s*(?:' + [
  '<local-command-caveat>', '<local-command-stdout>', '<command-name>',
  '<command-message>', '<task-notification>', '<system-reminder>',
  '<user-memory-input>', '<bash-input>',
  '\\[SYSTEM NOTIFICATION', '\\[Request interrupted',
  'Caveat: The messages below were generated',
  'This session is being continued from a previous conversation',
  '(?:\\d+ )?[Bb]ackground agents? .{0,200}?(?:was|were) stopped by the user',
  '/[a-z][a-z0-9:_-]*(?:\\s|$)',
].join('|') + ')');

const INTERRUPT_MARKER = /^\s*\[Request interrupted by user/;

/** Pre-`toolDenialKind` rejection sentence; anchored so file content quoting it cannot fire it. */
const USER_REJECTION = /^The user doesn't want (?:to proceed with this tool use|this)/;

/** `automode-*` kinds are deployment routing, not a verdict on the turn. */
const USER_DENIAL_KIND = 'user-rejected';

interface MineOptions {
  root: string;
  projects?: ReadonlyArray<string>;
}

/** Printed on every report so a silently dropped version cannot pass as a smaller corpus. */
interface MineSkips {
  unparsableLines: number;
  emptyFiles: number;
  nonInteractivePrompts: number;
  sidechainEntries: number;
  /** Truncates the live path at that point. */
  brokenChains: number;
  /** The shape a future version would drift into. */
  unknownContent: number;
  /** The same pre-filter production applies before spending a classifier call. */
  trivialTurns: number;
}

export interface MineResult {
  turns: CorpusTurn[];
  files: number;
  sessions: number;
  versions: string[];
  skips: MineSkips;
}

interface DraftTurn {
  project: string;
  sessionId: string;
  index: number;
  userMessage: string;
  createdAt: number;
  texts: string[];
  toolCalls: ToolCallRecord[];
  commands: string[];
  interrupted: boolean;
  toolRejected: boolean;
}

/** A 40k-character heredoc would dominate the corpus; the revert rule needs only verb and flags. */
const COMMAND_CHARS = 400;

const COMMANDS_PER_TURN = 40;

function recordCommand(commands: string[], command: string | undefined): void {
  if (command === undefined || commands.length >= COMMANDS_PER_TURN) return;
  commands.push(command.slice(0, COMMAND_CHARS));
}

export function mineTranscripts(opts: MineOptions): MineResult {
  const skips: MineSkips = {
    unparsableLines: 0, emptyFiles: 0, nonInteractivePrompts: 0, sidechainEntries: 0,
    brokenChains: 0, unknownContent: 0, trivialTurns: 0,
  };

  const versions = new Set<string>();
  const turns: CorpusTurn[] = [];
  let files = 0;
  let sessions = 0;

  for (const project of listProjects(opts.root, opts.projects)) {
    for (const file of listSessions(join(opts.root, project))) {
      files++;
      const mined = mineSession(project, file, skips, versions);

      if (mined.length === 0) continue;
      sessions++;
      turns.push(...mined);
    }
  }

  return { turns, files, sessions, versions: [...versions].sort(), skips };
}

function listProjects(root: string, wanted: ReadonlyArray<string> | undefined): string[] {
  // Only an absent root means empty; any other read failure must not report an empty corpus.
  const dirents = tolerate(() => readdirSync(root, { withFileTypes: true }), 'enoent') ?? [];
  const entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const filters = (wanted ?? []).filter((filter) => filter !== '');

  return entries
    .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
    .sort();
}

/** `subagents/` is not descended into: those sidechains are dropped anyway. */
function listSessions(dir: string): string[] {
  // ENOENT: a live session removed it since the root was listed.
  const dirents = tolerate(() => readdirSync(dir, { withFileTypes: true }), 'enoent') ?? [];

  return dirents
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(dir, entry.name))
    .sort();
}

/** Walks over every entry with a uuid (timings, hook summaries, compaction boundaries link the chain too),
 * then drops non-conversational links. */
function livePath(lines: ReadonlyArray<string>, skips: MineSkips, versions: Set<string>): Entry[] {
  const byUuid = new Map<string, Entry>();
  const order: Entry[] = [];

  for (const line of lines) {
    if (line.trim() === '') continue;
    let parsed: JsonValue;

    try {
      parsed = parseJsonValue(line);
    } catch (error) {
      if (classify({ cause: error }) !== 'malformed-input') throw error;
      skips.unparsableLines++;
      continue;
    }

    const entry = normalizedEntry({ value: parsed });

    if (!entry) {
      skips.unparsableLines++;
      continue;
    }

    if (entry.version !== undefined) versions.add(entry.version);

    if (entry.uuid === undefined) continue;
    byUuid.set(entry.uuid, entry);
    order.push(entry);
  }

  if (order.length === 0) return [];

  const path: Entry[] = [];
  let cursor: Entry | undefined = order[order.length - 1];
  const guard = new Set<string>();

  while (cursor !== undefined) {
    const uuid = cursor.uuid;

    if (uuid === undefined) break;

    if (guard.has(uuid)) break;
    guard.add(uuid);
    path.push(cursor);
    const parent = cursor.parentUuid;

    if (parent === undefined) break;
    cursor = byUuid.get(parent);

    if (cursor === undefined) skips.brokenChains++;
  }

  path.reverse();

  return path.filter((entry) => {
    if (entry.type !== 'user' && entry.type !== 'assistant') return false;

    if (entry.isSidechain === true) {
      skips.sidechainEntries++;

      return false;
    }

    return true;
  });
}

/** Versions recording no `entrypoint` count as interactive. */
function isNonInteractive(entry: Entry): boolean {
  return (entry.entrypoint !== undefined && entry.entrypoint !== 'cli') ||
    entry.sessionKind === 'bg';
}

function mineSession(
  project: string,
  file: string,
  skips: MineSkips,
  versions: Set<string>,
): CorpusTurn[] {
  let lines: string[];

  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch (error) {
    // A session listed moments ago can be gone before it is read.
    if (classify({ cause: error }) !== 'enoent') throw error;
    skips.emptyFiles++;

    return [];
  }

  const path = livePath(lines, skips, versions);

  if (path.length === 0) {
    skips.emptyFiles++;

    return [];
  }

  const sessionId = basename(file, '.jsonl');
  const drafts: DraftTurn[] = [];
  let current: DraftTurn | null = null;

  for (const entry of path) {
    const content = entry.message?.content;
    const contentArray = v.safeParse(JsonArraySchema, content);
    const contentText = v.safeParse(v.string(), content);

    if (entry.type === 'assistant') {
      if (current === null || !contentArray.success) continue;

      for (const raw of contentArray.output) {
        const block = normalizedBlock({ value: raw });

        if (!block) continue;

        if (block.type === 'text' && block.text !== undefined) current.texts.push(block.text);

        if (block.type === 'tool_use' && block.name !== undefined) {
          const args = block.input ?? {};
          current.toolCalls.push({ name: block.name, args, result: null });
          recordCommand(current.commands, stringValue(args.command));
        }
      }

      continue;
    }

    // Tool results and the interrupt marker are signals about the turn in flight; only a real prompt closes it.
    if (contentArray.success) {
      for (const raw of contentArray.output) {
        const block = normalizedBlock({ value: raw });

        if (!block) continue;

        if (block.type !== 'tool_result' || current === null) continue;

        if (entry.toolDenialKind === USER_DENIAL_KIND || USER_REJECTION.test(blockText(block.content))) {
          current.toolRejected = true;
        }
      }
    } else if (!contentText.success) {
      skips.unknownContent++;
      continue;
    }

    let text: string | null;

    if (contentText.success) text = contentText.output;
    else if (contentArray.success) text = firstText(contentArray.output);
    else continue;

    if (text === null) continue;

    if (entry.interruptedMessageId !== undefined || INTERRUPT_MARKER.test(text)) {
      if (current !== null) current.interrupted = true;
      continue;
    }

    if (entry.isMeta === true || entry.isCompactSummary === true || SYNTHETIC_PROMPT.test(text)) continue;

    // Close the turn rather than skip, so harness work is not attributed to the owner's previous request.
    if (isNonInteractive(entry)) {
      skips.nonInteractivePrompts++;
      current = null;
      continue;
    }

    current = {
      project,
      sessionId,
      index: drafts.length,
      userMessage: text,
      createdAt: entry.timestamp !== undefined ? Date.parse(entry.timestamp) : Number.NaN,
      texts: [], toolCalls: [], commands: [], interrupted: false, toolRejected: false,
    };
    drafts.push(current);
  }

  return finishTurns(drafts, skips);
}

function firstText(content: ReadonlyArray<JsonValue>): string | null {
  const texts = content.flatMap((raw): string[] => {
    const block = normalizedBlock({ value: raw });

    return block?.type === 'text' && block.text !== undefined ? [block.text] : [];
  });

  return texts.length === 0 ? null : texts.join('\n');
}

/** Texts window through the production `EVIDENCE_BUDGETS`, so corpus and `turn_outcomes` rows match. */
function finishTurns(drafts: ReadonlyArray<DraftTurn>, skips: MineSkips): CorpusTurn[] {
  const turns: CorpusTurn[] = [];

  for (const [index, draft] of drafts.entries()) {
    if (isTrivialTurn({ userMessage: draft.userMessage, toolCalls: draft.toolCalls })) {
      skips.trivialTurns++;
      continue;
    }

    const next = drafts[index + 1];
    const response = draft.texts.join('\n\n').trim();
    turns.push({
      project: draft.project,
      sessionId: draft.sessionId,
      item: {
        outcomeId: `${draft.project}/${draft.sessionId}/${draft.index}`,
        userMessage: evidenceWindow(draft.userMessage, EVIDENCE_BUDGETS.storedUserMessage),
        assistantResponse: evidenceWindow(
          response === ''
            ? `(no text response, ${draft.toolCalls.length} tool call${draft.toolCalls.length === 1 ? '' : 's'})`
            : response,
          EVIDENCE_BUDGETS.storedAssistantResponse,
        ),
        followup: next === undefined
          ? null
          : evidenceWindow(next.userMessage, EVIDENCE_BUDGETS.storedFollowup),
        createdAt: Number.isFinite(draft.createdAt) ? draft.createdAt : 0,
      },
      signals: {
        interrupted: draft.interrupted,
        toolRejected: draft.toolRejected,
        nextTurnCommands: next?.commands ?? [],
      },
    });
  }

  return turns;
}

export function renderMineSkips(result: MineResult): string[] {
  const { skips } = result;

  return [
    `- ${result.files} session files, ${result.sessions} of them yielding turns`,
    `- CLI versions: ${result.versions.length === 0 ? '(none recorded)' : result.versions.join(', ')}`,
    `- skipped: ${skips.nonInteractivePrompts} non-interactive prompts,` +
      ` ${skips.emptyFiles} unreadable/empty files, ${skips.trivialTurns} trivial turns`,
    `- unread: ${skips.unparsableLines} unparsable lines, ${skips.unknownContent} unknown content shapes,` +
      ` ${skips.brokenChains} broken parent chains (${skips.sidechainEntries} sub-agent entries dropped by design)`,
  ];
}
