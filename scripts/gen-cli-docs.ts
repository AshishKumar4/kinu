#!/usr/bin/env bun
// Write docs/CLI.md from the CLI's own command registry. `--check` verifies the
// checked-in copy is current instead of writing it (what the test runs).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProgram } from '../packages/cli/src/program';
import { renderCliReference } from '../packages/cli/src/cli-reference';

const target = join(import.meta.dir, '..', 'docs', 'CLI.md');
const rendered = renderCliReference(buildProgram());

if (process.argv.includes('--check')) {
  const current = readFileSync(target, 'utf8');
  if (current !== rendered) {
    console.error('docs/CLI.md is stale. Regenerate it: bun run docs:cli');
    process.exit(1);
  }
  console.log('docs/CLI.md is current.');
} else {
  writeFileSync(target, rendered);
  console.log(`Wrote ${target}`);
}
