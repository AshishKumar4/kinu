/**
 * Reading the owner's Claude Code session transcripts into corpus turns.
 *
 * Claude Code appends one JSON object per line to
 * `~/.claude/projects/<slugified-cwd>/<session>.jsonl`. This module turns those
 * files into the `(request → work → what the user did next)` triples that
 * evolution/behavior-labels.ts labels. It is the ONLY place in the codebase
 * that knows that file format, and it is strictly read-only: nothing here
 * opens a file for writing, and the mined turns are the only thing that leaves.
 *
 * Three things about the format are load-bearing.
 *
 *  - **The file is a DAG, not a list.** Rewinding a conversation, editing a
 *    message and re-sending it, or resuming a session all append a new branch
 *    whose `parentUuid` points back above the fork, leaving the abandoned
 *    branch in the file. Reading in line order would splice dead branches into
 *    the live conversation and invent follow-ups that never happened. So the
 *    live path is walked backwards from the last entry through `parentUuid`,
 *    which is the surviving conversation and nothing else.
 *
 *  - **The schema drifts across CLI versions, and the drift is not announced.**
 *    Interrupts carry an `interruptedMessageId` field in recent versions and
 *    only a `[Request interrupted by user]` text marker in older ones; tool
 *    denials carry `toolDenialKind` in recent versions and only the rejection
 *    sentence in older ones. Both readings are kept, because the older files
 *    are most of the history. Anything this module cannot read is SKIPPED AND
 *    COUNTED — never guessed at — and `MineSkips` is printed on every report so
 *    an unread quarter of the corpus cannot pass as an empty one.
 *
 *  - **Not every `type: "user"` line is the user.** Tool results, slash-command
 *    echoes, compaction summaries, background-task notifications and the
 *    interrupt marker itself all arrive as user-role entries. Sub-agent
 *    transcripts (`isSidechain`) and non-interactive sessions (`entrypoint`
 *    other than `cli`, or `sessionKind: "bg"`) are dropped outright: a label
 *    here is supposed to mean the OWNER did something, and in those sessions
 *    nobody was watching.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  EVIDENCE_BUDGETS, evidenceWindow, isTrivialTurn,
  type CorpusTurn, type ToolCallRecord,
} from '@proteus/core';

/** Where Claude Code keeps them. */
export function defaultTranscriptRoot(home: string): string {
  return join(home, '.claude', 'projects');
}

// ── The wire shapes, as far as this reader needs them ────────────

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface Entry {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  isCompactSummary?: unknown;
  entrypoint?: unknown;
  sessionKind?: unknown;
  version?: unknown;
  timestamp?: unknown;
  interruptedMessageId?: unknown;
  toolDenialKind?: unknown;
  message?: { role?: unknown; content?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A block's text, whatever nesting the version wrapped it in. Tool results
 *  carry either a bare string or an array of text blocks. */
function blockText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

// ── Telling the owner's messages from everything else ────────────

/** Entries that arrive as the user but are not the user typing: CLI wrappers,
 *  slash-command echoes, and the notices the CLI posts on the user's behalf.
 *  Anchored at the start, because each of these is a prefix the CLI prepends
 *  rather than a phrase that could appear in prose.
 *
 *  Every entry here was found by reading what the corpus actually produced —
 *  the `/loop` echo and the background-agent notices in particular, which
 *  otherwise arrive as long shouty "user messages" and fire the rules. */
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

/** The rejection sentence older CLI versions used before `toolDenialKind`
 *  existed. Anchored at the start of the tool result so a file whose CONTENT
 *  quotes the sentence cannot fire it. */
const USER_REJECTION = /^The user doesn't want (?:to proceed with this tool use|this)/;

/** `toolDenialKind` values that mean the person said no. The `automode-*`
 *  kinds are the deployment's routing, not a verdict on the turn. */
const USER_DENIAL_KIND = 'user-rejected';

// ── Mining ───────────────────────────────────────────────────────

export interface MineOptions {
  /** `~/.claude/projects` or a fixture directory. */
  root: string;
  /** Keep only projects whose directory name contains one of these. Empty
   *  means every project. */
  projects?: ReadonlyArray<string>;
  /** Stop after this many turns. 0 or absent means the whole corpus. */
  limit?: number;
}

/** Everything the reader declined to read, by reason. Printed on every report:
 *  a miner that silently drops a version's files reports a smaller corpus and
 *  looks identical to one that mined it all. */
export interface MineSkips {
  /** Lines that were not JSON. */
  unparsableLines: number;
  /** Session files with no reconstructable conversation at all. */
  emptyFiles: number;
  /** Prompts from a non-interactive session (SDK entrypoint, background). */
  nonInteractivePrompts: number;
  /** Sub-agent transcripts. */
  sidechainEntries: number;
  /** A `parentUuid` naming an entry the file does not contain, which truncates
   *  the live path at that point. */
  brokenChains: number;
  /** User entries whose content was neither a string nor a block array — the
   *  shape a future version would drift into. */
  unknownContent: number;
  /** Turns dropped by the trivial-turn pre-filter, the same one production
   *  applies before spending a classifier call. */
  trivialTurns: number;
}

export interface MineResult {
  turns: CorpusTurn[];
  files: number;
  /** Files that yielded at least one turn. */
  sessions: number;
  /** CLI versions the corpus was mined from, so schema drift is visible. */
  versions: string[];
  skips: MineSkips;
}

/** One turn under construction, before it knows what came next. */
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

/** Longest shell command kept for the revert rule, and how many per turn. The
 *  rule needs the verb and its flags; a 40k-character heredoc in the corpus
 *  file would be all of the corpus. */
const COMMAND_CHARS = 400;
const COMMANDS_PER_TURN = 40;

/**
 * Walk every project under `root` and return the turns it yields.
 *
 * Projects are visited in sorted order and sessions oldest-file-first, so a
 * `--limit` takes a stable prefix rather than a different corpus each run.
 */
export function mineTranscripts(opts: MineOptions): MineResult {
  const skips: MineSkips = {
    unparsableLines: 0, emptyFiles: 0, nonInteractivePrompts: 0, sidechainEntries: 0,
    brokenChains: 0, unknownContent: 0, trivialTurns: 0,
  };
  const versions = new Set<string>();
  const turns: CorpusTurn[] = [];
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY;
  let files = 0;
  let sessions = 0;

  for (const project of listProjects(opts.root, opts.projects)) {
    for (const file of listSessions(join(opts.root, project))) {
      if (turns.length >= limit) return { turns, files, sessions, versions: [...versions].sort(), skips };
      files++;
      const mined = mineSession(project, file, skips, versions);
      if (mined.length === 0) continue;
      sessions++;
      turns.push(...mined.slice(0, limit - turns.length));
    }
  }
  return { turns, files, sessions, versions: [...versions].sort(), skips };
}

function listProjects(root: string, wanted: ReadonlyArray<string> | undefined): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const filters = (wanted ?? []).filter((filter) => filter !== '');
  return entries
    .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
    .sort();
}

/** Session files of one project, oldest first. Sub-agent transcripts live in a
 *  `subagents/` subdirectory and are not descended into: they are the sidechain
 *  the reader drops anyway, and reading them would double-count the work. */
function listSessions(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The live conversation of one session file, oldest entry first.
 *
 * The chain is walked over EVERY entry that carries a uuid, not just the
 * conversational ones: turn timings, hook summaries and compaction boundaries
 * are links in it too, and a walk that only knew about user and assistant
 * entries snapped at the first one of those and returned a single message.
 * Non-conversational links are dropped from the result after the walk, once
 * they have done their job of connecting it.
 */
function livePath(lines: ReadonlyArray<string>, skips: MineSkips, versions: Set<string>): Entry[] {
  const byUuid = new Map<string, Entry>();
  const order: Entry[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skips.unparsableLines++;
      continue;
    }
    if (!isRecord(parsed)) {
      skips.unparsableLines++;
      continue;
    }
    const entry = parsed as Entry;
    if (typeof entry.version === 'string') versions.add(entry.version);
    if (typeof entry.uuid !== 'string') continue;
    byUuid.set(entry.uuid, entry);
    order.push(entry);
  }
  if (order.length === 0) return [];

  const path: Entry[] = [];
  let cursor: Entry | undefined = order[order.length - 1];
  const guard = new Set<string>();
  while (cursor !== undefined) {
    const uuid = cursor.uuid as string;
    if (guard.has(uuid)) break;
    guard.add(uuid);
    path.push(cursor);
    const parent = cursor.parentUuid;
    if (typeof parent !== 'string') break;
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

/** True for a message nobody was watching — SDK-driven or a background session.
 *  An interrupt or a refusal there is the harness, not the owner. Versions that
 *  record no `entrypoint` predate both and count as interactive. */
function isNonInteractive(entry: Entry): boolean {
  return (typeof entry.entrypoint === 'string' && entry.entrypoint !== 'cli') ||
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
  } catch {
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
    if (entry.type === 'assistant') {
      if (current === null || !Array.isArray(content)) continue;
      for (const raw of content) {
        if (!isRecord(raw)) continue;
        const block = raw as ContentBlock;
        if (block.type === 'text' && typeof block.text === 'string') current.texts.push(block.text);
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          const args = isRecord(block.input) ? block.input : {};
          current.toolCalls.push({ name: block.name, args, result: null });
          const command = args.command;
          if (typeof command === 'string' && current.commands.length < COMMANDS_PER_TURN) {
            current.commands.push(command.slice(0, COMMAND_CHARS));
          }
        }
      }
      continue;
    }

    // A user entry. Tool results and the interrupt marker are SIGNALS about the
    // turn in flight; only a real prompt closes it and opens the next.
    if (Array.isArray(content)) {
      for (const raw of content) {
        if (!isRecord(raw)) continue;
        const block = raw as ContentBlock;
        if (block.type !== 'tool_result' || current === null) continue;
        if (entry.toolDenialKind === USER_DENIAL_KIND || USER_REJECTION.test(blockText(block.content))) {
          current.toolRejected = true;
        }
      }
    } else if (typeof content !== 'string') {
      skips.unknownContent++;
      continue;
    }

    const text = typeof content === 'string' ? content : firstText(content);
    if (text === null) continue;
    if (typeof entry.interruptedMessageId === 'string' || INTERRUPT_MARKER.test(text)) {
      if (current !== null) current.interrupted = true;
      continue;
    }
    if (entry.isMeta === true || entry.isCompactSummary === true || SYNTHETIC_PROMPT.test(text)) continue;
    // A real prompt, but not one the owner typed. Closing the turn in flight
    // rather than skipping the line keeps the harness's work from being
    // attributed to the owner's previous request.
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
      createdAt: typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN,
      texts: [], toolCalls: [], commands: [], interrupted: false, toolRejected: false,
    };
    drafts.push(current);
  }

  return finishTurns(drafts, skips);
}

/** The first text block of a user content array, or null when it carries none
 *  (a pure tool-result or image entry). */
function firstText(content: ReadonlyArray<unknown>): string | null {
  const texts = content
    .filter((raw): raw is ContentBlock => isRecord(raw) && (raw as ContentBlock).type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''));
  return texts.length === 0 ? null : texts.join('\n');
}

/**
 * Close the drafts into corpus turns: each one's follow-up is the next draft's
 * request, and each one's revert evidence is the next draft's shell commands.
 *
 * Texts are windowed through the same `EVIDENCE_BUDGETS` the production ledger
 * stores turns at, so a corpus row and a `turn_outcomes` row show a rater the
 * same amount of the same thing.
 */
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
            ? `(no text response — ${draft.toolCalls.length} tool call${draft.toolCalls.length === 1 ? '' : 's'})`
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

/** The skip counts as report lines, in the order they matter. */
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
