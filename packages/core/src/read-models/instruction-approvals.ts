/**
 * What the owner reads before deciding which workspace instruction files may hold system
 * placement (KINU-N028). Derived, never stored: a stored pending table would be one the agent
 * fills by writing files. Must never join `SLATE_READ_MODELS`: a Slate could render a fake of it.
 */

import {
  instructionDigest,
  type InstructionApproval, type InstructionDecision,
  type InstructionTrust, type InstructionTrustResolver,
} from '../safety/instruction-trust';
import {
  discoverSkills, readSkillFile, type SkillsVfs,
} from '../skills/discover';
import { boundedInt } from '../utils/bounds';
import { seekPage, type Page, type PageRequest } from '../session/page';
import type { AgentsMdSources } from '../prompting/agents-md';
import { tolerateAsync } from '../obs/index';

/** An AGENTS.md is project doctrine; a skill can also declare a tool restriction. */
export type InstructionSourceKind = 'agents_md' | 'skill';

/** A listing row: metadata and the standing decision only. Digest, preview and trust need the
 *  bytes, which only {@link readInstructionSource} reads, one file at a time. */
export interface InstructionSourceRow {
  readonly path: string;
  readonly kind: InstructionSourceKind;
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
  /** What an approval would bind. */
  readonly digest: string;
  /** A decision naming other bytes still reads as its value; `trust` says it does not count. */
  readonly decision: InstructionDecision | 'none';
  readonly trust: InstructionTrust;
  /** `unavailable`: discovery declined to follow the path; it reaches the model nowhere. */
  readonly placement: 'system' | 'reference' | 'unavailable';
  /** Only on an `unavailable` row. */
  readonly reason?: string;
  readonly preview: string;
}

const DEFAULT_PREVIEW_CHARS = 2_000;

/** C0 controls and DEL, bidi overrides and isolates, directional marks, zero-width characters
 *  and the BOM: characters that make text display as something it is not. */
const MISREPRESENTING_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff],
];

const MISREPRESENTING = new RegExp(
  `[${MISREPRESENTING_RANGES.map(([lo, hi]) =>
    lo === hi
      ? `\\u{${lo.toString(16)}}`
      : `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`).join('')}]`,
  'gu',
);

/** The text renders in the owner's UI, and an approval is worth only the owner's reading of it,
 *  so misrepresenting characters become a visible U+FFFD. Tabs and newlines stay. */
export function previewInstruction(content: string, maxChars = DEFAULT_PREVIEW_CHARS): string {
  const safe = content.replace(MISREPRESENTING, '\uFFFD');

  return safe.length <= maxChars ? safe : `${safe.slice(0, maxChars)}…`;
}

const DEFAULT_INSTRUCTION_PAGE = 25;

/** RPC-reachable, so the limit is clamped: a negative limit answers a page it cannot anchor. */
const MAX_INSTRUCTION_PAGE = 200;

function instructionAnchor(row: InstructionSourceRow): string {
  return `${row.kind}\u0000${row.path}`;
}

function compareRows(a: InstructionSourceMeta, b: InstructionSourceMeta): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;

  if (a.path < b.path) return -1;

  if (a.path > b.path) return 1;

  return 0;
}

/** Ordered by identity (kind, path) only, so a cursor survives a rewrite between pages. */
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

/** `content` is the bytes just read, so the digest and the verdict describe the same instant. */
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
 * Every source an owner could decide about, by metadata alone: no skill body is read. A file too
 * large for `admissionTokens` is still listed, so the owner learns it is there and inert.
 */
export async function gatherApprovableInstructions(input: {
  readonly agentsMd?: AgentsMdSources;
  readonly skillsVfs: SkillsVfs;
  readonly admissionTokens: number;
}): Promise<InstructionSourceMeta[]> {
  const sources: InstructionSourceMeta[] = (input.agentsMd?.admitted ?? []).map((file) => ({
    path: file.path, kind: 'agents_md' as const, bytes: file.content.length,
  }));

  // The model is told to open these by path, so the owner must be able to revoke them.
  for (const reference of input.agentsMd?.referenced ?? []) {
    sources.push({
      path: reference.path, kind: 'agents_md', bytes: reference.bytes,
      reason: 'too large for this model\'s window; left on disk for the agent to open',
    });
  }

  for (const entry of input.agentsMd?.unavailable ?? []) {
    sources.push({ path: entry.path, kind: 'agents_md', bytes: 0, reason: entry.reason });
  }

  const discovery = await discoverSkills(input.skillsVfs, { admissionTokens: input.admissionTokens });
  const skills = discovery.skills.filter((skill) => skill.bodyRef.kind === 'file');

  const sizes = await Promise.all(skills.map(async (skill) => {
    const ref = skill.bodyRef;

    if (ref.kind !== 'file' || !input.skillsVfs.stat) return ref.kind === 'file' ? ref.chars : 0;

    return (await input.skillsVfs.stat(ref.path))?.size ?? ref.chars;
  }));

  for (let index = 0; index < skills.length; index += 1) {
    const skill = skills[index];

    if (skill.bodyRef.kind !== 'file') continue;
    sources.push({ path: skill.bodyRef.path, kind: 'skill', bytes: sizes[index] });
  }

  for (const unread of discovery.unread) {
    sources.push({ path: unread.path, kind: 'skill', bytes: unread.bytes });
  }

  return sources;
}

/** Reads one file. The verdict and digest cover the bytes just read, so a file that changes
 *  before the owner approves no longer matches the shown digest and nothing is granted. */
export async function openInstructionSource(input: {
  readonly path: string;
  readonly agentsMd?: AgentsMdSources;
  readonly skillsVfs: SkillsVfs;
  readonly trust: InstructionTrustResolver;
  readonly decisions: readonly InstructionApproval[];
  readonly previewChars?: number;
  /** The byte ceiling the file is read under derives from it (`admissionBytes`). */
  readonly admissionTokens: number;
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

  if (input.agentsMd?.unavailable?.some((entry) => entry.path === input.path)) return null;

  // Only ENOENT is an absence (a listing taken before a delete); an I/O failure propagates.
  const source = await tolerateAsync(
    () => readSkillFile(input.skillsVfs, { kind: 'file', path: input.path, chars: 0 }, input.admissionTokens),
    'enoent',
  );

  return source === undefined ? null : open('skill', source);
}
