/** @path, quoted and ~-prefixed tokens (drag-drop) that stat to a regular file become attachments. Images and
 * PDFs inline as data-URL parts; other files stay path references for the agent's tools. */

import { stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import type { PromptFile } from '@kinu.run/core';
import { renderThrownChain, tolerateAsync } from '@kinu.run/core/obs';
import { formatBytes } from './display';

/** Everything else is reachable through the agent's read tools; inlining would only burn context. */
const INLINE_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
  ['.pdf', 'application/pdf'],
]);

interface PathToken {
  raw: string;
  index: number;
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

/** Purely lexical; resolution happens in resolvePromptAttachments. */
function extractPathTokens(text: string): PathToken[] {
  const tokens: PathToken[] = [];

  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[2];
    const index = m.index + m[1].length;
    const mention = raw.startsWith('@');
    const path = stripQuotes(mention ? raw.slice(1) : raw);

    if (path) tokens.push({ raw, index, path, mention });
  }

  return tokens;
}

interface ResolvedAttachment {
  path: string;
  filename: string;
  /** Null when the file stays a path reference for the agent's read tools. */
  mediaType: string | null;
  size: number;
}

interface PromptAttachments {
  text: string;
  files: PromptFile[];
  attached: ResolvedAttachment[];
  /** Per-file problems (over-cap, unreadable) — surfaced, never silent. */
  errors: string[];
}

/** A candidate beyond POSIX name/path limits cannot name a file, and `stat` would throw ENAMETOOLONG
 *  (not ENOENT), killing the turn; treat it as prose. */
const NAME_MAX_BYTES = 255;

const PATH_MAX_BYTES = 4095;

/** Retries once without one trailing punctuation mark so "see @/tmp/shot.png." matches. */
async function statCandidate(token: string, cwd: string): Promise<{ path: string; size: number } | null> {
  const candidates = [token];
  const trimmed = token.replace(/[.,;:!?]$/, '');

  if (trimmed !== token && trimmed) candidates.push(trimmed);

  for (const candidate of candidates) {
    const expanded = candidate.startsWith('~/') ? homedir() + candidate.slice(1) : candidate;
    const absolute = resolve(cwd, expanded);

    if (
      Buffer.byteLength(absolute) > PATH_MAX_BYTES
      || absolute.split('/').some((part) => Buffer.byteLength(part) > NAME_MAX_BYTES)
    ) continue;
    // ENOENT is normal (most words are not paths); any other stat failure surfaces to the user.
    const stats = await tolerateAsync(() => stat(absolute), 'enoent');

    if (stats?.isFile()) return { path: absolute, size: stats.size };
  }

  return null;
}

interface PromptAttachmentOptions {
  /** The cap belongs to the backend that stores the message and the two differ by 8x, so no default. */
  limitBytes: number;
  cwd?: string;
}

export async function resolvePromptAttachments(
  text: string,
  { limitBytes, cwd = process.cwd() }: PromptAttachmentOptions,
): Promise<PromptAttachments> {
  const files: PromptFile[] = [];
  const attached: ResolvedAttachment[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const rewrites: Array<{ index: number; raw: string }> = [];
  // Aggregate across all file parts: they persist together in one backend message.
  let inlineBudget = limitBytes;

  for (const token of extractPathTokens(text)) {
    const found = await statCandidate(token.path, cwd);

    if (!found) continue;

    if (token.mention) rewrites.push({ index: token.index, raw: token.raw });

    if (seen.has(found.path)) continue;
    seen.add(found.path);

    const filename = basename(found.path);
    const mediaType = INLINE_MEDIA_TYPES.get(extname(found.path).toLowerCase()) ?? null;

    if (!mediaType) {
      attached.push({ path: found.path, filename, mediaType: null, size: found.size });
      continue;
    }

    if (found.size > inlineBudget) {
      const reason = found.size > limitBytes
        ? `${formatBytes(found.size)}; max ${formatBytes(limitBytes)} per message`
        : `the ${formatBytes(limitBytes)} per-message budget is already used`;

      errors.push(`${filename} is too large to attach (${reason}). Left as a path reference.`);
      attached.push({ path: found.path, filename, mediaType: null, size: found.size });
      continue;
    }

    try {
      const bytes = await readFile(found.path);
      files.push({ filename, mediaType, url: `data:${mediaType};base64,${bytes.toString('base64')}` });
      attached.push({ path: found.path, filename, mediaType, size: found.size });
      inlineBudget -= found.size;
    } catch (err) {
      errors.push(`Could not read ${filename}: ${renderThrownChain({ cause: err })}`);
    }
  }

  // Right-to-left so indices stay valid.
  let rewritten = text;

  for (const r of rewrites.sort((a, b) => b.index - a.index)) {
    rewritten = rewritten.slice(0, r.index) + stripQuotes(r.raw.slice(1)) + rewritten.slice(r.index + r.raw.length);
  }

  return { text: rewritten, files, attached, errors };
}

export function describePromptAttachment(a: ResolvedAttachment): string {
  return `${a.filename} (${formatBytes(a.size)}${a.mediaType ? '' : ', referenced'})`;
}
