/** Where a file the agent names in chat opens: a local file on this machine, a cloud one on the web Files surface. */
import { cloudPlanes, findPlaneReferences, referencedPath, referencePrefixes, type PathPlanes } from '../vfs/resolve';
import { WORKSPACE_ROOT } from '../vfs/workspace-path';
import { APP_ROUTES } from './app-routes';

export interface FileLinks {
  /** The prefixes a reference may start with ({@link referencePrefixes}); any other scheme is prose. */
  readonly roots: readonly string[];
  /** The target a reference opens, or null when it names no file. */
  readonly href: (reference: string) => string | null;
}

/** A local workspace's files are this machine's: each reference opens as the file it names. */
export function localFileLinks(planes: PathPlanes): FileLinks {
  return {
    roots: referencePrefixes(planes),
    href: (reference) => {
      const at = referencedPath(reference, planes);

      return at === null ? null : `file://${encodeURI(at)}`;
    },
  };
}

/** A cloud workspace's files open on its Files surface, which lands on `?file=<reference>`; `machines` are its live ones. */
export function cloudFileLinks(origin: string, workspace: string, machines: readonly string[] = []): FileLinks {
  const page = new URL(APP_ROUTES.workspace.replace(':agentId', encodeURIComponent(workspace)), origin);

  return {
    roots: referencePrefixes(cloudPlanes(WORKSPACE_ROOT), machines),
    href: (reference) => {
      page.searchParams.set('file', reference);

      return page.toString();
    },
  };
}

/** Fenced code stays as written; inline code that is exactly a reference becomes a link around it. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

const INLINE_CODE = /(`[^`\n]*`)/u;

const LINK = /\[[^\]\n]*\]\(([^)\s]*)\)/gu;

/** `markdown` with each reference to `links.roots` written as a link to its target. */
export function linkFileReferences(markdown: string, links: FileLinks): string {
  let fence: string | null = null;

  return markdown.split('\n').map((line) => {
    const opened = FENCE.exec(line)?.[1];

    if (fence !== null) {
      if (opened !== undefined && opened[0] === fence[0] && opened.length >= fence.length) fence = null;

      return line;
    }

    if (opened !== undefined) {
      fence = opened;

      return line;
    }

    return line.split(INLINE_CODE).map((part, i) => (i % 2 === 1 ? codeLink(part, links) : proseLinks(part, links))).join('');
  }).join('\n');
}

function codeLink(code: string, links: FileLinks): string {
  const inner = code.slice(1, -1);
  const [only] = findPlaneReferences(inner, links.roots);
  const href = only !== undefined && only.index === 0 && only.reference === inner ? links.href(inner) : null;

  return href === null ? code : `[${code}](${href})`;
}

/** An existing link's reference target is rewritten in place; a bare reference becomes a link to itself. */
function proseLinks(prose: string, links: FileLinks): string {
  let out = '';
  let from = 0;

  for (const link of prose.matchAll(LINK)) {
    out += bareLinks(prose.slice(from, link.index), links);
    const target = link[1] ?? '';
    const href = findPlaneReferences(target, links.roots)[0]?.reference === target ? links.href(target) : null;
    out += href === null ? link[0] : `${link[0].slice(0, link[0].length - target.length - 1)}${href})`;
    from = link.index + link[0].length;
  }

  return out + bareLinks(prose.slice(from), links);
}

function bareLinks(prose: string, links: FileLinks): string {
  let out = '';
  let from = 0;

  for (const { index, reference } of findPlaneReferences(prose, links.roots)) {
    const href = links.href(reference);

    if (href === null) continue;
    out += `${prose.slice(from, index)}[${reference}](${href})`;
    from = index + reference.length;
  }

  return out + prose.slice(from);
}

/** A Files surface jump: each new nonce opens it again. */
export interface FilesFocus {
  readonly path: string;
  readonly file?: string;
  readonly nonce: number;
}

/** A file is previewed in its folder; a reference ending in `/`, or a bare root, names the folder. Null: it names nothing. */
export function filesFocusOf(reference: string): { readonly path: string; readonly file?: string } | null {
  const at = referencedPath(reference, cloudPlanes(WORKSPACE_ROOT));

  if (at === null) return null;

  if (reference.endsWith('/')) return { path: at };

  return { path: at.slice(0, at.lastIndexOf('/')) || '/', file: at };
}
