/** @path, quoted and ~-prefixed tokens (drag-drop) that stat to a regular file become attachments. Images and
 * PDFs upload as chat attachments do (`AgentClient.uploadAttachment`) and the message names their paths; other files
 * stay path references for the agent's tools. */

import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { FILE_TRANSFER_MAX_BYTES, readShellWord, referencePrefixes, resolvePath, type PathPlanes, type PromptFile } from '@kinu.run/core';
import { attempt, renderThrownChain, settle, tolerateAsync } from '@kinu.run/core/obs';
import { formatBytes } from '@kinu.run/core';
import { Effect, Result } from 'effect';

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

/** A pasted path as the shell it came from wrote it: its quotes and escapes undone; as written where it is no word. */
export function pastedPath(written: string): string {
  return readShellWord(written) ?? written;
}

/** How a word may name a file: a mention, a quoted path, or a home or absolute path a terminal's drag-and-drop wrote. */
const PATH_STARTS = ['@', '"', "'", '~/', '/'] as const;

/** Each whitespace-separated word of `text` as a shell reads it: quotes and backslash escapes keep spaces inside. */
function shellWords(text: string): { readonly raw: string; readonly index: number }[] {
  const words: { readonly raw: string; readonly index: number }[] = [];
  let at = 0;

  while (at < text.length) {
    while (at < text.length && /\s/u.test(text[at] ?? '')) at += 1;
    const start = at;

    while (at < text.length && !/\s/u.test(text[at] ?? '')) at = pastWordPart(text, at);

    if (at > start) words.push({ raw: text.slice(start, at), index: start });
  }

  return words;
}

/** Past one piece of a word at `at`: an escaped character, a quoted run (to the end of the line where it never closes), or one character. */
function pastWordPart(text: string, at: number): number {
  const char = text[at];

  if (char === '\\') return Math.min(at + 2, text.length);

  if (char !== '"' && char !== "'") return at + 1;
  let end = at + 1;

  while (end < text.length && text[end] !== char && text[end] !== '\n') end += char === '"' && text[end] === '\\' ? 2 : 1;

  return text[end] === char ? end + 1 : end;
}

/** Purely lexical; resolution happens in resolvePromptAttachments. */
function extractPathTokens(text: string): PathToken[] {
  const tokens: PathToken[] = [];

  for (const { raw, index } of shellWords(text)) {
    if (!PATH_STARTS.some((start) => raw.startsWith(start))) continue;
    const mention = raw.startsWith('@');
    const path = pastedPath(mention ? raw.slice(1) : raw);

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

/** A `prefix://` reference this workspace names, as its path on this machine; null for any other token. */
function planePath(candidate: string, planes: PathPlanes | undefined): string | null {
  const root = /^([^\s/:]+):\/\//u.exec(candidate)?.[1];

  if (planes === undefined || root === undefined || !referencePrefixes(planes).includes(root)) return null;

  // A reference that climbs above its plane is refused to the user, as the file tool refuses it.
  return resolvePath(candidate, planes).absolute;
}

/** Retries once without one trailing punctuation mark so "see @/tmp/shot.png." matches. */
async function statCandidate(token: string, cwd: string, planes: PathPlanes | undefined): Promise<{ path: string; size: number } | null> {
  const candidates = [token];
  const trimmed = token.replace(/[.,;:!?]$/, '');

  if (trimmed !== token && trimmed) candidates.push(trimmed);

  for (const candidate of candidates) {
    const expanded = candidate.startsWith('~/') ? homedir() + candidate.slice(1) : candidate;
    const absolute = planePath(candidate, planes) ?? resolve(cwd, expanded);

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
  /** Keeps a file as a chat attachment (`AgentClient.uploadAttachment`): the path the message names. */
  upload: (file: { readonly filename: string; readonly mediaType: string; readonly bytes: Uint8Array }) => Promise<string>;
  cwd?: string;
  /** A local workspace's planes, where its references are on this machine. */
  planes?: PathPlanes;
}

/** A plain chain: a one-shot turn's first send races its session's start-up context measure on these ticks. */
export function resolvePromptAttachments(
  text: string,
  { upload, cwd = process.cwd(), planes }: PromptAttachmentOptions,
): Promise<PromptAttachments> {
  return settle(Effect.gen(function* () {
  const files: PromptFile[] = [];
  const attached: ResolvedAttachment[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const rewrites: Array<{ index: number; raw: string }> = [];

  for (const token of extractPathTokens(text)) {
    const found = yield* Effect.promise(async () => await statCandidate(token.path, cwd, planes));

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

    // One upload's bound (`upload.file_bytes`), as for a file attached in the browser.
    if (found.size > FILE_TRANSFER_MAX_BYTES) {
      errors.push(`${filename} is too large to attach (${formatBytes(found.size)}; one upload carries ${formatBytes(FILE_TRANSFER_MAX_BYTES)}). Left as a path reference.`);
      attached.push({ path: found.path, filename, mediaType: null, size: found.size });
      continue;
    }

    const bytes = Result.try(() => readFileSync(found.path));

    if (Result.isFailure(bytes)) {
      errors.push(`Could not read ${filename}: ${renderThrownChain({ cause: bytes.failure })}`);
      continue;
    }

    const kept = yield* Effect.result(attempt({ doing: `uploading ${filename}`, otherwise: 'unavailable' },
      async () => await upload({ filename, mediaType, bytes: new Uint8Array(bytes.success) })));

    if (kept._tag === 'Failure') {
      errors.push(`Could not upload ${filename}: ${renderThrownChain({ cause: kept.failure })}. Left as a path reference.`);
      attached.push({ path: found.path, filename, mediaType: null, size: found.size });
      continue;
    }

    files.push({ filename, mediaType, path: kept.success });
    attached.push({ path: found.path, filename, mediaType, size: found.size });
  }

  // Right-to-left so indices stay valid.
  let rewritten = text;

  for (const r of rewrites.sort((a, b) => b.index - a.index)) {
    rewritten = rewritten.slice(0, r.index) + pastedPath(r.raw.slice(1)) + rewritten.slice(r.index + r.raw.length);
  }

  return { text: rewritten, files, attached, errors };
  }));
}

export function describePromptAttachment(a: ResolvedAttachment): string {
  return `${a.filename} (${formatBytes(a.size)}${a.mediaType ? '' : ', referenced'})`;
}
