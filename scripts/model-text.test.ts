import { describe, expect, test } from 'bun:test';
import { findWideText, terminalPackages } from './model-text';

const WORKER = 'packages/core/src/tools/memory-tool.ts';

const WEB = 'packages/cf-backend/src/components/Chip.tsx';

const CLI = 'packages/cli/src/display.ts';

const none = { web: new Set<string>(), terminalPackages: [] };

const noAsset = (file: string): string => { throw new Error(`no asset ${file}`); };

describe('model-text: red in every direction it claims', () => {
  test('a dash in a string, a template or an escape is found, with its line', () => {
    const found = findWideText(new Map([[WORKER, "const a = 'x';\nconst b = 'Search \u2014 fast';\nconst c = `${a} \u2192 read`;\nconst d = 'a \\u2014 b';"]]), none, noAsset);

    expect(found.map((each) => `${String(each.line)} ${each.character}`)).toEqual(['2 \u2014', '3 \u2192', '4 \u2014']);
  });

  test('Latin-1, a byte-order mark and a comment are not model text', () => {
    expect(findWideText(new Map([[WORKER, "// a \u2014 comment\nconst a = 'caf\u00e9 \u00b7 x';\nconst bom = '\\uFEFF';"]]), none, noAsset)).toEqual([]);
  });

  test('a Markdown file imported as text is read line by line', () => {
    const prompts = new Map([['packages/core/src/prompts/lead.md', 'one\ntwo \u2014 three']]);

    const found = findWideText(new Map([[WORKER, "import lead from '../prompts/lead.md' with { type: 'text' };\nexport { lead };"]]), none,
      (file) => prompts.get(file) ?? noAsset(file));

    expect(found).toEqual([{ file: 'packages/core/src/prompts/lead.md', line: 2, character: '\u2014' }]);
  });

  test('the web client, a terminal package and an @opentui module are the two renderers, and only those', () => {
    const sources = new Map([
      [WEB, "export const arrow = '\u2192';"],
      [CLI, "export const tick = '\u2713';"],
      ['packages/core/src/tui/view.tsx', "import { Box } from '@opentui/react';\nexport const bullet = '\u25cf';"],
      [WORKER, "export const tick = '\u2713';"],
    ]);

    expect(findWideText(sources, { web: new Set([WEB]), terminalPackages: ['packages/cli/'] }, noAsset).map((each) => each.file)).toEqual([WORKER]);
  });

  test('a terminal package is one whose manifest declares a bin', () => {
    expect(terminalPackages(new Map([
      ['packages/cli/package.json', '{"name":"cli","bin":{"kinu":"./bin/cli.ts"}}'],
      ['packages/core/package.json', '{"name":"core"}'],
    ]))).toEqual(['packages/cli/']);
  });
});
