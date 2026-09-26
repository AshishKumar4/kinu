/** The CLI reference is rendered from the command registry: every command, with its options and one example that
 *  runs it. Whether docs/CLI.md is that rendering is the commit tier's check, `bun scripts/gen-cli-docs.ts --check`. */

import { describe, expect, test } from 'bun:test';
import { buildProgram } from '../src/program';
import { renderCliReference } from '../src/cli-reference';
import { commandEntries } from '../src/display';

describe('the CLI reference', () => {
  test('documents every registered command, with its options', () => {
    const reference = renderCliReference(buildProgram());
    const entries = commandEntries(buildProgram());
    expect(entries.length).toBeGreaterThan(40);

    for (const entry of entries) {
      expect(reference).toContain(`### kinu ${entry.term}`);

      for (const option of entry.command.options.filter((o) => !o.hidden)) {
        expect(reference).toContain(`\`${option.flags}\``);
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
