// Scrub every trial's evidence under a run's artifact root before it leaves the machine that ran it, as the report is
// scrubbed (src/redact.ts): a local reader keeps the workspace's own words, and an artifact of this public repository
// carries nothing shaped like a credential. A JSON or JSONL file is scrubbed by its string values, so it stays one; a
// binary file is kept as it is.
//   bun evals/scripts/scrub-evidence.ts <artifact root>
import { isUtf8 } from 'node:buffer';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactFile } from '../src/redact';

const [root] = process.argv.slice(2);

if (root === undefined) throw new Error('Usage: bun evals/scripts/scrub-evidence.ts <artifact root>');

/** How many text files under `path` were scrubbed in place. */
function scrub(path: string): number {
  if (statSync(path).isDirectory()) return readdirSync(path).reduce((sum, name) => sum + scrub(join(path, name)), 0);

  const bytes = readFileSync(path);

  if (!isUtf8(bytes)) return 0;

  writeFileSync(path, redactFile(path, bytes.toString('utf8')));

  return 1;
}

const scrubbed = readdirSync(root).filter((name) => name.startsWith('evals-')).reduce((sum, name) => sum + scrub(join(root, name)), 0);

process.stdout.write(`Scrubbed ${String(scrubbed)} text files of trial evidence under ${root}\n`);
