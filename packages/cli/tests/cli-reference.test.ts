/**
 * docs/CLI.md is generated from the command registry, so the only thing worth
 * asserting is that the checked-in copy still matches what the registry says —
 * a new command or flag lands in the docs or breaks this test.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildProgram } from '../src/program.js';
import { renderCliReference } from '../src/cli-reference.js';
import { commandEntries } from '../src/display.js';

const docPath = join(resolve(__dirname, '../../..'), 'docs/CLI.md');

describe('docs/CLI.md', () => {
  test('is current — regenerate with `bun run docs:cli`', () => {
    expect(readFileSync(docPath, 'utf8')).toBe(renderCliReference(buildProgram()));
  });

  test('documents every registered command, with its options', () => {
    const doc = readFileSync(docPath, 'utf8');
    const entries = commandEntries(buildProgram());
    expect(entries.length).toBeGreaterThan(40);
    for (const entry of entries) {
      expect(doc).toContain(`### proteus ${entry.term}`);
      for (const option of entry.command.options.filter((o) => !o.hidden)) {
        expect(doc).toContain(`\`${option.flags}\``);
      }
    }
  });
});
