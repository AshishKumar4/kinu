/**
 * The pictures an answer names, in the order it names them, so the chat shows each once after the paragraph that names
 * it: a file on one of the workspace's planes, read through the workspace's own file route, or a web address, which
 * loads only when the owner asks (it would tell that site the owner read the answer).
 */
import { normalizePath } from '@nimbus-sh/core/vfs/composite.js';
import { cloudPlanes, findPlaneReferences, referencedPath, type PathPlanes } from '../vfs/resolve';
import { walkedPath } from '../vfs/workspace-path';

export type ImageMachine = 'workspace' | 'computer' | 'device';

export type NamedImage =
  | {
    readonly kind: 'file';
    /** As the answer wrote it. */
    readonly written: string;
    /** Its absolute path in the workspace's file plane. */
    readonly path: string;
    readonly machine: ImageMachine;
    /** The device's name, for a device's file. */
    readonly device?: string;
  }
  | { readonly kind: 'web'; readonly written: string; readonly url: string; readonly host: string };

const EXTENSION = String.raw`\.(?:png|jpe?g|gif|webp|avif|svg)`;

const IMAGE = new RegExp(`${EXTENSION}$`, 'iu');

/** `![alt](target)`, the target up to its closing bracket or a title. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu;

const WEB = new RegExp(String.raw`https?:\/\/[^\s<>()"'\x60]+?${EXTENSION}(?:\?[^\s<>()"'\x60]*)?(?=$|[\s<>()"'\x60.,;:!?])`, 'giu');

/** A path in prose or code: absolute, or relative with at least one folder, ending in an image's extension. */
const PATH = new RegExp(String.raw`(?<![\w@.:/-])(?:\/|~\/)?(?:[\w.@+-]+\/)+[\w.@+-]*${EXTENSION}(?=$|[\s<>()"'\x60,;:!?]|\.(?:\s|$))`, 'giu');

/** A file name alone, which only an inline code span names as a file. */
const CODE_NAME = new RegExp(String.raw`^[\w.@+-]+${EXTENSION}$`, 'iu');

const INLINE_CODE = /`([^`\n]+)`/gu;

function located(path: string): Pick<Extract<NamedImage, { kind: 'file' }>, 'machine' | 'device'> {
  if (path === '/computer' || path.startsWith('/computer/')) return { machine: 'computer' };
  const device = /^\/pc\/([^/]+)\//u.exec(path)?.[1];

  return device === undefined ? { machine: 'workspace' } : { machine: 'device', device };
}

/** Every picture `text` names, each once, in order. `home` is where a relative path starts; `roots`, the reference
 *  prefixes the chat links (`vfs`, `computer`, a device's name). */
export function namedImages(text: string, at: { readonly home: string; readonly roots: readonly string[] }): NamedImage[] {
  const found: { readonly index: number; readonly written: string }[] = [];

  for (const match of text.matchAll(MARKDOWN_IMAGE)) found.push({ index: match.index, written: match[1] ?? '' });

  for (const match of text.matchAll(WEB)) found.push({ index: match.index, written: match[0] });

  for (const { index, reference } of findPlaneReferences(text, at.roots)) if (IMAGE.test(reference)) found.push({ index, written: reference });

  for (const match of text.matchAll(PATH)) found.push({ index: match.index, written: match[0] });

  for (const match of text.matchAll(INLINE_CODE)) {
    const code = (match[1] ?? '').trim();

    if (CODE_NAME.test(code)) found.push({ index: match.index, written: code });
  }

  const planes = cloudPlanes(at.home);
  const named = new Map<string, NamedImage>();

  for (const { written } of found.sort((left, right) => left.index - right.index)) {
    const image = imageOf(written, planes, at.home);

    if (image !== null) {
      const key = image.kind === 'file' ? image.path : image.url;

      if (!named.has(key)) named.set(key, image);
    }
  }

  return [...named.values()];
}

function imageOf(written: string, planes: PathPlanes, home: string): NamedImage | null {
  if (!IMAGE.test(written.replace(/\?.*$/u, ''))) return null;

  if (/^https?:\/\//iu.test(written)) {
    const host = URL.canParse(written) ? new URL(written).host : '';

    return host === '' ? null : { kind: 'web', written, url: written, host };
  }

  // A data URL or another scheme the chat does not read names no file here.
  if (/^[a-z][\w+.-]*:(?!\/\/)/iu.test(written)) return null;

  const path = written.includes('://') ? referencedPath(written, planes) : normalizePath(walkedPath(written.replace(/^~\//u, ''), home));

  return path === null ? null : { kind: 'file', written, path, ...located(path) };
}
