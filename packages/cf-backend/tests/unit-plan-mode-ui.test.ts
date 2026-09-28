import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Plan mode browser contract', () => {
  test('the patched document viewer excludes diagram engines from Kinu', () => {
    const viewer = readFileSync(join(import.meta.dir, '../../../node_modules/@plannotator/ui/components/Viewer.tsx'), 'utf8');
    const patch = readFileSync(join(import.meta.dir, '../../../patches/@plannotator%2Fui@0.30.0.patch'), 'utf8');

    for (const feature of ['Tater', 'Attachments', 'QuickLabel', 'Pinpoint', 'Vim', 'Graphviz', 'Mermaid']) {
      expect(viewer).not.toContain(feature);
    }

    expect(viewer).toContain('applyAnnotations(eligible)');
    expect(viewer).toContain('computeListIndices(blocks)');
    expect(viewer).toContain("split(/(?<!\\\\)\\|/)");
    expect(viewer).toContain('target="_blank" rel="noopener noreferrer"');
    expect(viewer).toContain("!href.startsWith('#')");
    expect(viewer).toContain('!/^https?:\\/\\//i.test(href)');
    const additions = patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
    expect(additions).not.toContain('@pierre/diffs');
    expect(patch).not.toContain('.bun-tag-');
  });

  test('ships the selected upstream license text with the integration', () => {
    const notice = readFileSync(join(import.meta.dir, '../../../THIRD_PARTY_NOTICES.md'), 'utf8');
    const license = readFileSync(join(import.meta.dir, '../../../third_party/plannotator-LICENSE-MIT'), 'utf8');
    expect(notice).toContain('third_party/plannotator-LICENSE-MIT');
    expect(license).toContain('Copyright (c) 2025 backnotprop');
    expect(license).toContain('Permission is hereby granted');
  });
});
