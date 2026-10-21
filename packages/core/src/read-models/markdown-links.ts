import { slateLinkId } from '../slates/host-context';

/** The mdast fields the reference pass uses, shared with the Markdown renderer. */
export interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly identifier?: string;
  children?: MarkdownNode[];
}

/** Links prose outside existing links and code; `code` accepts whole inline-code references. */
export function linkProse(
  tree: MarkdownNode,
  find: (value: string) => ReadonlyArray<{ readonly index: number; readonly text: string }>,
  code: (value: string) => boolean,
  linked?: (node: MarkdownNode) => void,
): void {
  const split = (value: string): MarkdownNode[] | null => {
    const parts: MarkdownNode[] = [];
    let from = 0;

    for (const hit of find(value)) {
      if (hit.index > from) parts.push({ type: 'text', value: value.slice(from, hit.index) });
      const link = { type: 'link', url: hit.text, children: [{ type: 'text', value: hit.text }] };

      parts.push(link);
      linked?.(link);
      from = hit.index + hit.text.length;
    }

    if (parts.length === 0) return null;

    if (from < value.length) parts.push({ type: 'text', value: value.slice(from) });

    return parts;
  };

  const walk = (node: MarkdownNode): void => {
    if (node.type === 'link' || node.type === 'linkReference') {
      linked?.(node);

      return;
    }

    if (node.type === 'inlineCode' || node.type === 'code') return;
    const children = node.children ?? [];

    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      if (child.type === 'inlineCode' && code(child.value ?? '')) {
        const link = { type: 'link', url: child.value, children: [child] };

        children[i] = link;
        linked?.(link);
        continue;
      }

      const parts = child.type === 'text' ? split(child.value ?? '') : null;

      if (parts === null) {
        walk(child);
        continue;
      }

      children.splice(i, 1, ...parts);
      i += parts.length - 1;
    }
  };

  walk(tree);
}

const SLATE_LINK = /slate:\/\/[^\s)\]>"'`]+/g;

/** The one promotion pass: bare prose addresses, slate links, and exact inline-code addresses draw cards. */
export function promoteSlateLinks(tree: MarkdownNode, linked?: (id: string) => void): void {
  const definitions = linked === undefined ? undefined : new Map<string, string>();

  const collectDefinitions = (node: MarkdownNode): void => {
    if (definitions !== undefined && node.type === 'definition' && node.identifier !== undefined && node.url !== undefined && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }

    for (const child of node.children ?? []) collectDefinitions(child);
  };

  if (linked !== undefined) collectDefinitions(tree);

  linkProse(tree,
    (value) => [...value.matchAll(SLATE_LINK)]
      .filter((hit) => slateLinkId(hit[0]) !== null)
      .map((hit) => ({ index: hit.index, text: hit[0] })),
    (value) => slateLinkId(value) !== null,
    linked === undefined ? undefined : (node) => {
      const href = node.type === 'linkReference' ? definitions?.get(node.identifier ?? '') : node.url;
      const id = slateLinkId(href ?? '');

      if (id !== null) linked(id);
    });
}
