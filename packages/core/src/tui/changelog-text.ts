import type { ChangelogEntry } from '../evolution/changelog';
import { CHANGE_KIND_GLYPH } from '../tui-presentation';

export function renderChangelogText(
  entries: ReadonlyArray<ChangelogEntry>,
  opts: { unseenCount?: number } = {},
): string {
  if (entries.length === 0) {
    return 'Evolution changelog is empty — no self-changes recorded yet.';
  }

  const header = `Evolution changelog (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` +
    (opts.unseenCount ? ` · ${opts.unseenCount} unseen` : '') + ')';

  const lines = [header];

  for (const [i, e] of entries.entries()) {
    const when = new Date(e.at).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(`${String(i + 1).padStart(3)}. ${CHANGE_KIND_GLYPH[e.kind]} ${e.summary}`);
    lines.push(`      ${when}${e.evidence ? ` · ${e.evidence}` : ''}${e.revert ? ' · revertable' : ''}`);

    for (const item of e.items ?? []) {
      lines.push(`      - ${item.summary}`);
      lines.push(`        ${item.evidence}`);
    }
  }

  return lines.join('\n');
}
