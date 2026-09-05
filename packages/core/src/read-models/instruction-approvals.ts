/**
 * What the owner reads before deciding which workspace instruction files may
 * hold system placement (KINU-N028).
 *
 * The list is DERIVED, never stored. A file waiting on the owner is not a row
 * somebody has to remember to write — it is simply a source discovery found
 * whose bytes carry no approval. That matters beyond tidiness: a durable
 * "pending" table would be a table the AGENT could fill by writing files, which
 * is a spam surface pointed at the one queue the owner trusts.
 *
 * SECURITY: like `pending-actions.ts`, this must never join
 * `VIEW_DATA_SOURCES`. An agent-drawn view that could render this list could
 * render a convincing fake of it, and this is precisely the surface an owner
 * reads before granting instruction bytes real force. It stays host-owned.
 *
 * Pure: the host owns the file planes and does the gathering, so "what is
 * waiting, and how it reads" is one testable decision rather than one per
 * surface.
 */

import {
  instructionDigest,
  type InstructionApproval, type InstructionDecision, type InstructionMigrationEntry,
  type InstructionTrust, type InstructionTrustResolver,
} from '../safety/instruction-trust';
import {
  discoverSkills, readSkillFile, type DiscoverOpts, type SkillsVfs,
} from '../skills/discover';
import { boundedInt } from '../utils/bounds';
import { seekPage, type Page, type PageRequest } from './page';
import type { AgentsMdSources } from '../prompting/agents-md';
import { tolerateAsync } from '../obs/index';

/** Which discovery found the file. The owner needs it because the two carry
 *  different authority: an AGENTS.md is project doctrine, while a skill can
 *  also declare a tool restriction. */
export type InstructionSourceKind = 'agents_md' | 'skill';

/**
 * One row of the PAGED listing: metadata plus the owner's own standing answer.
 *
 * Deliberately carries no digest, no preview and no trust verdict. All three
 * need the file's BYTES, and reading every workspace skill to draw a list is
 * exactly what this contract exists to avoid — a workspace can hold as many
 * skill files as the agent cares to write. `decision` needs no bytes: it is what
 * the owner already said, read from one indexed row.
 *
 * Whether the CURRENT bytes still match that decision is answered per row, on
 * demand, by {@link readInstructionSource}.
 */
export interface InstructionSourceRow {
  readonly path: string;
  readonly kind: InstructionSourceKind;
  /** Size from the plane's own metadata; no content was read to learn it. */
  readonly bytes: number;
  readonly decision: InstructionDecision | 'none';
  /** Why the path is inert, when discovery declined to follow it. */
  readonly reason?: string;
}

/** One instruction source discovered by metadata alone. */
export interface InstructionSourceMeta {
  readonly path: string;
  readonly kind: InstructionSourceKind;
  readonly bytes: number;
  readonly reason?: string;
}

/** One row of the approval surface, opened. */
export interface InstructionSourceView {
  readonly path: string;
  readonly kind: InstructionSourceKind;
  /** Characters of the content this digest was taken over. */
  readonly bytes: number;
  /** What an approval would bind. Shown so the owner can tell two revisions of
   *  one path apart, and so a decision stays auditable afterwards. */
  readonly digest: string;
  /** The standing decision for this path, or 'none' when there has never been
   *  one. A decision naming OTHER bytes still reads as its own value — such a
   *  row is stale, not absent, and `trust` is what says it does not count. */
  readonly decision: InstructionDecision | 'none';
  readonly trust: InstructionTrust;
  /** Where these bytes are reaching the model right now, in one word a surface
   *  can render without re-deriving the rule. `unavailable` is a path discovery
   *  declined to follow: it reaches the model nowhere, and cannot be approved. */
  readonly placement: 'system' | 'reference' | 'unavailable';
  /** Why the path is inert, for an `unavailable` row and nothing else. Present
   *  so the owner is told a rule file is doing nothing, instead of seeing a file
   *  that looks live. */
  readonly reason?: string;
  /** The content, made safe to show a human (see {@link previewInstruction}). */
  readonly preview: string;
}

/** Characters of a file the owner is shown before approving it. Enough to read
 *  a short instruction file whole and to recognise the top of a long one; the
 *  full text is a file they can open. */
const DEFAULT_PREVIEW_CHARS = 2_000;

/**
 * Characters that can make text read as something other than what it is.
 *
 * C0 controls and DEL, the bidirectional overrides and isolates
 * (U+202A–U+202E, U+2066–U+2069), the directional marks (U+200E, U+200F), the
 * zero-width joiners and spaces (U+200B–U+200D) and the BOM (U+FEFF).
 */
const MISREPRESENTING_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff],
];

/** Built from codepoints rather than written as a literal: a regex literal
 *  holding control characters is unreadable in review and hides exactly what it
 *  matches, which for this rule is the whole point. */
const MISREPRESENTING = new RegExp(
  `[${MISREPRESENTING_RANGES.map(([lo, hi]) =>
    lo === hi
      ? `\\u{${lo.toString(16)}}`
      : `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`).join('')}]`,
  'gu',
);

/**
 * Content the owner can safely be shown, and safely be held to.
 *
 * The threat here is not the model's. This text renders in the OWNER's UI, so
 * the risk is that the bytes misrepresent themselves: a bidirectional override
 * can display a line in an order it was not written in, and a zero-width
 * character can hide a word entirely. An approval is worth exactly as much as
 * the owner's reading of what they approved, so anything that can make bytes
 * read differently than they are becomes U+FFFD — visible, so the owner knows
 * something was there rather than being quietly shown a lie.
 *
 * Tabs and newlines stay: they are layout, and these are markdown files.
 */
export function previewInstruction(content: string, maxChars = DEFAULT_PREVIEW_CHARS): string {
  const safe = content.replace(MISREPRESENTING, '\uFFFD');
  return safe.length <= maxChars ? safe : `${safe.slice(0, maxChars)}…`;
}

/**
 * The approval surface for one scope: every instruction source the host found,
 * what its bytes are doing right now, and what approving them would bind.
 *
 * Ordered kind-then-path so the list is stable across polls and does not
 * re-animate under the owner's cursor.
 *
 * A built-in is never a row: it has no path to approve, no bytes an owner could
 * revoke, and it is not waiting on anybody. Hosts should not offer one, and one
 * offered anyway is dropped rather than shown as a decision that does nothing.
 */
/** Page size for the approval listing, following the other read models'
 *  per-read default. */
const DEFAULT_INSTRUCTION_PAGE = 25;

/**
 * The ceiling on one approval page. The run list's own ceiling: this listing is
 * RPC-reachable, and a negative limit answers with a page it cannot anchor.
 */
const MAX_INSTRUCTION_PAGE = 200;

/** The listing's stable identity: kind then path, so a page boundary lands in
 *  the same place on every read and a cursor keeps meaning something. */
function instructionAnchor(row: InstructionSourceRow): string {
  return `${row.kind}\u0000${row.path}`;
}

function compareRows(a: InstructionSourceMeta, b: InstructionSourceMeta): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * One page of the approval surface, ordered kind-then-path.
 *
 * Ordering is total and derived from identity alone, so it does not move when a
 * file's bytes change. That is what makes the cursor survive a rewrite between
 * pages: an edit changes what the row SAYS when opened, never where it sits.
 */
export function listInstructionApprovals(input: {
  readonly sources: readonly InstructionSourceMeta[];
  readonly decisions: readonly InstructionApproval[];
} & PageRequest): Page<InstructionSourceRow> {
  const decisionByPath = new Map<string, InstructionApproval>();
  for (const row of input.decisions) decisionByPath.set(row.path, row);

  const ordered = [...input.sources].sort(compareRows).map((meta): InstructionSourceRow => {
    const row: InstructionSourceRow = {
      path: meta.path,
      kind: meta.kind,
      bytes: meta.bytes,
      decision: decisionByPath.get(meta.path)?.decision ?? 'none',
    };
    return meta.reason === undefined ? row : { ...row, reason: meta.reason };
  });

  const limit = boundedInt(input.limit, DEFAULT_INSTRUCTION_PAGE, 1, MAX_INSTRUCTION_PAGE);
  const after = input.cursor?.after;
  const from = after === undefined
    ? ordered
    : ordered.filter((row) => instructionAnchor(row) > after);
  return seekPage(from.slice(0, limit + 1), limit, instructionAnchor);
}

/**
 * One source, opened: what approving it would bind, and what it is doing now.
 *
 * The caller reads THIS file and nothing else, which is the whole point of the
 * split. `content` is the bytes it just read, so the digest and the verdict
 * describe the same instant.
 */
export function readInstructionSource(input: {
  readonly path: string;
  readonly kind: InstructionSourceKind;
  readonly content: string;
  readonly trust: InstructionTrust;
  readonly decision?: InstructionDecision | 'none';
  readonly previewChars?: number;
}): InstructionSourceView {
  return {
    path: input.path,
    kind: input.kind,
    bytes: input.content.length,
    digest: instructionDigest(input.content),
    decision: input.decision ?? 'none',
    trust: input.trust,
    placement: input.trust === 'unverified' ? 'reference' : 'system',
    preview: previewInstruction(input.content, input.previewChars),
  };
}

/**
 * Every instruction source an owner could decide about, by METADATA alone.
 *
 * No skill body is read here. Discovery already knows each file's path and size
 * from its front-matter pass, and that is all a listing needs — reading every
 * body to draw a list would let a workspace full of agent-written skill files
 * decide how much work the owner's settings page does.
 *
 * A file too large for `admissionTokens` is still listed, with the size that
 * excluded it, because the owner is the one person who should be told it is
 * there and inert. Per-turn discovery bounds itself separately through context
 * admission; this bound is the page.
 */
export async function gatherApprovableInstructions(input: {
  readonly agentsMd?: AgentsMdSources;
  readonly skillsVfs: SkillsVfs;
  readonly admissionTokens: number;
  readonly skillsDir?: string;
}): Promise<InstructionSourceMeta[]> {
  const sources: InstructionSourceMeta[] = (input.agentsMd?.admitted ?? []).map((file) => ({
    path: file.path, kind: 'agents_md' as const, bytes: file.content.length,
  }));
  // A file that WOULD be carried and simply did not fit the window. The model is
  // told to open these by path, so an owner who cannot see them cannot revoke a
  // path the agent is being pointed at — and an agent that grows an AGENTS.md
  // past the budget would otherwise remove it from this page by doing so.
  for (const reference of input.agentsMd?.referenced ?? []) {
    sources.push({
      path: reference.path, kind: 'agents_md', bytes: reference.bytes,
      reason: 'too large for this model\'s window; left on disk for the agent to open',
    });
  }
  for (const entry of input.agentsMd?.unavailable ?? []) {
    sources.push({ path: entry.path, kind: 'agents_md', bytes: 0, reason: entry.reason });
  }

  const opts: DiscoverOpts = { admissionTokens: input.admissionTokens };
  if (input.skillsDir !== undefined) opts.skillsDir = input.skillsDir;
  const discovery = await discoverSkills(input.skillsVfs, opts);
  const skills = discovery.skills.filter((skill) => skill.bodyRef.kind === 'file');
  const sizes = await Promise.all(skills.map(async (skill) => {
    const ref = skill.bodyRef;
    if (ref.kind !== 'file' || !input.skillsVfs.stat) return ref.kind === 'file' ? ref.chars : 0;
    return (await input.skillsVfs.stat(ref.path))?.size ?? ref.chars;
  }));
  for (let index = 0; index < skills.length; index += 1) {
    const skill = skills[index]!;
    if (skill.bodyRef.kind !== 'file') continue;
    sources.push({ path: skill.bodyRef.path, kind: 'skill', bytes: sizes[index]! });
  }
  for (const unread of discovery.unread) {
    sources.push({ path: unread.path, kind: 'skill', bytes: unread.bytes });
  }
  return sources;
}

/**
 * The one migration-time snapshot: current AGENTS.md bytes plus complete,
 * valid workspace skill files.
 *
 * It runs before the first post-upgrade turn, not during ordinary discovery.
 * The marker in InstructionApprovalStore then closes the baseline forever: a
 * new path appearing after this call has no row and begins unverified.
 *
 * `admissionTokens` is the real turn allocation, not an invented migration
 * maximum. Oversized files stayed inert before upgrade and remain unverified;
 * migration never materializes an unbounded corpus merely to grandfather it.
 */
export async function snapshotExistingInstructions(input: {
  readonly agentsMd?: AgentsMdSources;
  readonly skillsVfs: SkillsVfs;
  readonly admissionTokens: number;
}): Promise<InstructionMigrationEntry[]> {
  const entries: InstructionMigrationEntry[] = (input.agentsMd?.admitted ?? []).map((file) => ({
    path: file.path,
    digest: instructionDigest(file.content),
  }));
  const discovery = await discoverSkills(input.skillsVfs, {
    admissionTokens: input.admissionTokens,
  });
  for (const skill of discovery.skills) {
    if (skill.bodyRef.kind !== 'file') continue;
    // One raw source at a time: retain only its digest before moving on, so a
    // large valid corpus cannot hold every source string during migration.
    const source = await readSkillFile(input.skillsVfs, skill.bodyRef);
    entries.push({
      path: skill.bodyRef.path,
      digest: instructionDigest(source),
    });
  }
  return entries;
}

/**
 * Open ONE source: read that file's bytes, and only that file's.
 *
 * The counterpart to the paged listing. A row is opened when the owner asks to
 * read it, so the cost of the surface is one file per click rather than every
 * skill in the workspace per page.
 *
 * `trust` is asked about the bytes just read, so the verdict and the digest
 * describe the same instant — the approve/preview gap therefore fails closed: if
 * the file moves on before the owner clicks approve, the digest they were shown
 * no longer matches and nothing is granted.
 */
export async function openInstructionSource(input: {
  readonly path: string;
  readonly agentsMd?: AgentsMdSources;
  readonly skillsVfs: SkillsVfs;
  readonly trust: InstructionTrustResolver;
  readonly decisions: readonly InstructionApproval[];
  readonly previewChars?: number;
}): Promise<InstructionSourceView | null> {
  const decision: InstructionDecision | 'none' =
    input.decisions.find((row) => row.path === input.path)?.decision ?? 'none';
  const open = (kind: InstructionSourceKind, content: string): InstructionSourceView => {
    const request = {
      path: input.path, kind, content, decision,
      trust: input.trust(input.path, content),
    };
    return input.previewChars === undefined
      ? readInstructionSource(request)
      : readInstructionSource({ ...request, previewChars: input.previewChars });
  };

  const admitted = input.agentsMd?.admitted.find((file) => file.path === input.path);
  if (admitted) return open('agents_md', admitted.content);
  // A path discovery declined to follow has no bytes to open, and an oversized
  // file was never read; both stay listing-only rather than being materialized
  // here just to have something to show.
  if (input.agentsMd?.unavailable?.some((entry) => entry.path === input.path)) return null;

  // Absence is an answer here — the owner may be looking at a listing taken
  // before the file was deleted. Anything else (a permission or I/O failure) is
  // NOT an absence and propagates, for the same reason discovery only absorbs
  // ENOENT and ELOOP: reporting a broken disk as "no such file" would be a lie
  // the owner would act on.
  const source = await tolerateAsync(
    () => readSkillFile(input.skillsVfs, { kind: 'file', path: input.path, chars: 0 }),
    'enoent',
  );
  return source === undefined ? null : open('skill', source);
}
