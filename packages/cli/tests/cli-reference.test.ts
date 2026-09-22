/** docs/CLI.md is generated from the command registry; the checked-in copy must match it. */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildProgram } from '../src/program';
import { renderCliReference } from '../src/cli-reference';
import { commandEntries } from '../src/display';

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
      expect(doc).toContain(`### kinu ${entry.term}`);

      for (const option of entry.command.options.filter((o) => !o.hidden)) {
        expect(doc).toContain(`\`${option.flags}\``);
      }
    }
  });

  test('gives every command one example that runs that command', () => {
    const unexampled = commandEntries(buildProgram())
      .filter((entry) => {
        const path = entry.term.split(' ').filter((word) => /^[a-z]/.test(word)).join(' ');

        return !entry.example?.startsWith(`kinu ${path}`);
      })
      .map((entry) => entry.term);

    expect(unexampled).toEqual([]);
  });
});
