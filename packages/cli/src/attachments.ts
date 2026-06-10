/**
 * Prompt attachments for the CLI chat surfaces (TUI + readline REPL).
 *
 * Mention syntax — one syntax, both backends: an explicit @path, plus quoted
 * ("…" / '…') and ~-prefixed tokens (terminal drag-drop pastes those), that
 * stat to an existing regular file. Images and PDFs are inlined as data-URL
 * PromptFiles for multimodal models; every other file stays a path reference
 * in the text — the agent reads it with its fs tools (local backend) or the
 * device tunnel (cloud). @mentions are rewritten to the bare path so the
 * model sees plain prose.
 */

import { stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import type { PromptFile } from '@proteus/core';

/** Per-file cap for inlined attachments (matches the web composer). */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** File types worth inlining as model-visible parts. Everything else is
 *  reachable through the agent's read tools, so inlining would only burn
 *  context. */
const INLINE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export interface PathToken {
  /** Exact matched substring (including the @ / quotes). */
  raw: string;
  /** Start offset of `raw` in the prompt. */
  index: number;
  /** Candidate path with @ and quotes stripped (~ not yet expanded). */
  path: string;
  /** True for explicit @mentions — rewritten to the bare path on send. */
  mention: boolean;
}

const TOKEN_RE = /(^|\s)(@(?:"[^"\n]+"|'[^'\n]+'|\S+)|"[^"\n]+"|'[^'\n]+'|~\/\S+)/g;

function stripQuotes(s: string): string {
  return (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))
    ? s.slice(1, -1)
    : s;
}

/** Candidate file-path tokens in a prompt. Purely lexical — resolution
 *  (stat + size policy) happens in resolvePromptAttachments. */
export function extractPathTokens(text: string): PathToken[] {
  const tokens: PathToken[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[2]!;
    const index = m.index! + m[1]!.length;
    const mention = raw.startsWith('@');
    const path = stripQuotes(mention ? raw.slice(1) : raw);
    if (path) tokens.push({ raw, index, path, mention });
  }
  return tokens;
}

export interface ResolvedAttachment {
  /** Absolute path on disk. */
  path: string;
  filename: string;
  /** Inline media type when attached as a model-visible part; null when the
   *  file stays a path reference for the agent's read tools. */
  mediaType: string | null;
  size: number;
}

export interface PromptAttachments {
  /** The prompt with @mentions rewritten to bare paths. */
  text: string;
  /** Data-URL parts for the inlined attachments (images / PDFs). */
  files: PromptFile[];
  /** Every detected file mention — inlined or referenced — for chips. */
  attached: ResolvedAttachment[];
  /** Per-file problems (over-cap, unreadable) — surfaced, never silent. */
  errors: string[];
}

/** Expand ~ and resolve against cwd; retry once without one trailing
 *  punctuation mark so "see @/tmp/shot.png." still matches the file. */
async function statCandidate(token: string, cwd: string): Promise<{ path: string; size: number } | null> {
  const candidates = [token];
  const trimmed = token.replace(/[.,;:!?]$/, '');
  if (trimmed !== token && trimmed) candidates.push(trimmed);
  for (const candidate of candidates) {
    const expanded = candidate.startsWith('~/') ? homedir() + candidate.slice(1) : candidate;
    const absolute = resolve(cwd, expanded);
    try {
      const s = await stat(absolute);
      if (s.isFile()) return { path: absolute, size: s.size };
    } catch { /* not a file — try the next candidate */ }
  }
  return null;
}

/**
 * Resolve a prompt's path mentions into attachments. Both chat surfaces call
 * this in their submit path and hand `{ text, files }` to AgentClient.send.
 */
export async function resolvePromptAttachments(text: string, cwd = process.cwd()): Promise<PromptAttachments> {
  const files: PromptFile[] = [];
  const attached: ResolvedAttachment[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const rewrites: Array<{ index: number; raw: string }> = [];

  for (const token of extractPathTokens(text)) {
    const found = await statCandidate(token.path, cwd);
    if (!found) continue;
    if (token.mention) rewrites.push({ index: token.index, raw: token.raw });
    if (seen.has(found.path)) continue;
    seen.add(found.path);

    const filename = basename(found.path);
    const mediaType = INLINE_MEDIA_TYPES[extname(found.path).toLowerCase()] ?? null;
    if (!mediaType) {
      attached.push({ path: found.path, filename, mediaType: null, size: found.size });
      continue;
    }
    if (found.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${filename} is too large to attach (${formatBytes(found.size)}; max ${formatBytes(MAX_ATTACHMENT_BYTES)}) — left as a path reference.`);
      attached.push({ path: found.path, filename, mediaType: null, size: found.size });
      continue;
    }
    try {
      const bytes = await readFile(found.path);
      files.push({ filename, mediaType, url: `data:${mediaType};base64,${bytes.toString('base64')}` });
      attached.push({ path: found.path, filename, mediaType, size: found.size });
    } catch (err) {
      errors.push(`Could not read ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Strip the @ off resolved mentions, right-to-left so indices stay valid.
  let rewritten = text;
  for (const r of rewrites.sort((a, b) => b.index - a.index)) {
    rewritten = rewritten.slice(0, r.index) + stripQuotes(r.raw.slice(1)) + rewritten.slice(r.index + r.raw.length);
  }

  return { text: rewritten, files, attached, errors };
}

/** Chip label for a resolved attachment, e.g. "shot.png (24.3 KB)" or
 *  "notes.txt (1.2 KB, referenced)". */
export function describePromptAttachment(a: ResolvedAttachment): string {
  return `${a.filename} (${formatBytes(a.size)}${a.mediaType ? '' : ', referenced'})`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
