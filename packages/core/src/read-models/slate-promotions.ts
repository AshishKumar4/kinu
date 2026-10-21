// The renderer's CommonMark/GFM grammar over an answer, apart from markdown-links.ts so it loads at the first preview
// (background-event.ts `slatesToPreview`): every isolate's start compiled it, though only a turn's end reads it
// (platform-catalog `worker.startup_ms`).
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { slateUiSegments } from '../slates/ui-blocks';
import { promoteSlateLinks } from './markdown-links';

/** Parse each answer segment with the renderer's CommonMark/GFM grammar, never joining separate text parts. */
export function promotedSlateIds(text: string): ReadonlySet<string> {
  const ids = new Set<string>();

  for (const segment of slateUiSegments(text)) {
    if (segment.kind === 'slate') continue;
    const tree = fromMarkdown(segment.text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

    promoteSlateLinks(tree, (id) => { ids.add(id); });
  }

  return ids;
}
