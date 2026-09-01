/**
 * The workload the deployed lifecycle suite writes THROUGH a devbox's own work
 * directory, and the digest it verifies the restored bytes against.
 *
 * It runs INSIDE the container, under the bun the sandbox image already
 * carries, because every byte has to travel the strategy's real write path: the
 * s3fs mount for `r2fs`, the overlay upper for `snapshot-chain` and
 * `overlay-cas`, the journal daemon's FUSE mount for both candidates. A driver
 * that wrote through the `/write` route instead would be measuring the Durable
 * Object's file API rather than the storage strategy under test.
 *
 * WHY A DIGEST OF THE MANIFEST RATHER THAN A FILE COUNT. A count answers
 * "something is there", which is the assertion two shipped strategies passed
 * while restoring a blank disk. This hashes the sorted `<sha256> <relative
 * path>` line of every regular file and hashes that listing, so ONE value
 * changes when any of these changes: a byte inside a file, a file's name, a
 * file that should have been deleted coming back, or a file that should have
 * survived going missing. The suite compares the value taken before a
 * checkpoint against the value taken after the restore, and a mismatch is
 * reported with both counts and both byte totals so a reader can tell a
 * resurrection from a loss.
 *
 * EVERY COMMAND IS DETERMINISTIC AND SELF-DESCRIBING. Content is derived from a
 * seeded counter rather than /dev/urandom, so a tree can be rebuilt and
 * compared across runs, and every command answers one JSON object on stdout —
 * the suite parses that object and never scrapes prose.
 */

import { createHash, createHmac } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync,
  statSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** Where the mid-scale tree goes: npm-shaped, and named so the default exclude
 *  policy carries it. See {@link npmPlan}. */
const MID_SCALE_DIRECTORY = 'deps';

/** One generated file: where it goes and how many bytes it holds. */
interface Plan {
  readonly path: string;
  readonly bytes: number;
}

/**
 * Deterministic bytes for one path.
 *
 * HMAC over the path and a chunk index, so two files never share content, the
 * same path always produces the same bytes, and the payload is incompressible
 * enough that a strategy cannot make a 30 MiB tree cheap by deflating zeros.
 */
function payload(seed: string, path: string, bytes: number): Buffer {
  const chunks: Buffer[] = [];
  let produced = 0;
  for (let index = 0; produced < bytes; index += 1) {
    const chunk = createHmac('sha256', seed).update(`${path}:${String(index)}`).digest();
    chunks.push(chunk);
    produced += chunk.length;
  }
  return Buffer.concat(chunks).subarray(0, bytes);
}

/** The small tree: mixed sizes and depths, the shape an editing session leaves
 *  behind. `delete-me-*` exist to be removed before the first checkpoint, which
 *  is how the restore is asked to honour a deletion rather than only a write. */
function smallPlan(root: string): Plan[] {
  const plans: Plan[] = [
    { path: join(root, 'README.md'), bytes: 2_048 },
    { path: join(root, 'src/index.ts'), bytes: 16_384 },
    { path: join(root, 'src/deep/nested/module.ts'), bytes: 8_192 },
    { path: join(root, 'assets/logo.bin'), bytes: 262_144 },
    { path: join(root, 'assets/data.bin'), bytes: 262_144 },
  ];
  for (let index = 0; index < 120; index += 1) {
    plans.push({ path: join(root, `notes/note-${String(index).padStart(3, '0')}.txt`), bytes: 3_072 });
  }
  for (let index = 0; index < 3; index += 1) {
    plans.push({ path: join(root, `delete-me-${String(index)}.txt`), bytes: 1_024 });
  }
  return plans;
}

/**
 * The mid-scale tree: npm-SHAPED — many small files across many package
 * directories, the layout every strategy is worst at — under a directory the
 * default exclude policy does not drop.
 *
 * NOT `node_modules`, and that is the whole reason this comment exists.
 * `CHAIN_EXCLUDES` lists `node_modules` (with `dist`, `target`, `.cache`,
 * `.next`, `.turbo`, `.bun`, `__pycache__`, `.venv` and `*.log`) because a
 * regenerable tree is deliberately not carried in a whole-tree base. A suite
 * that wrote its mid-scale tree there would find it missing after the restore
 * and report a documented product policy as data loss — the worst kind of red,
 * because it is indistinguishable from the real thing until someone reads the
 * policy.
 */
function npmPlan(root: string, targetBytes: number): Plan[] {
  const plans: Plan[] = [];
  const perFile = 12_288;
  const filesPerPackage = 24;
  const packages = Math.max(1, Math.ceil(targetBytes / (perFile * filesPerPackage)));
  for (let pkg = 0; pkg < packages; pkg += 1) {
    const base = join(root, `pkg-${String(pkg).padStart(3, '0')}`);
    plans.push({ path: join(base, 'package.json'), bytes: 512 });
    for (let file = 0; file < filesPerPackage; file += 1) {
      plans.push({ path: join(base, 'lib', `mod-${String(file).padStart(2, '0')}.js`), bytes: perFile });
    }
  }
  return plans;
}

/** What one materialised plan cost, as the suite records it. */
interface Written {
  readonly files: number;
  readonly bytes: number;
}

/** Write one plan, creating parents, and answer what it cost. */
function materialise(plans: readonly Plan[], seed: string): Written {
  let bytes = 0;
  for (const plan of plans) {
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, payload(seed, plan.path, plan.bytes));
    bytes += plan.bytes;
  }
  return { files: plans.length, bytes };
}

/** Every regular file under `root`, relative and sorted, so the digest below is
 *  a property of the tree rather than of the order a directory happened to be
 *  read in. */
function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  if (existsSync(root)) visit(root);
  return found.map((path) => relative(root, path)).sort();
}

interface TreeDigest {
  readonly files: number;
  readonly bytes: number;
  readonly digest: string;
}

function digestTree(root: string): TreeDigest {
  const listing = createHash('sha256');
  let bytes = 0;
  const relatives = walk(root);
  for (const path of relatives) {
    const absolute = join(root, path);
    const content = readFileSync(absolute);
    bytes += content.length;
    listing.update(`${createHash('sha256').update(content).digest('hex')}  ${path}\n`);
  }
  return { files: relatives.length, bytes, digest: listing.digest('hex') };
}

/** A named argument, or the stated default. Parsed here rather than by a
 *  library because this file is copied into a container that installs nothing. */
function argument(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  return value ?? fallback;
}

/**
 * Hold a handle open over bytes that are already written and fsync'd.
 *
 * The suite runs this DETACHED and leaves it running across the checkpoint and
 * the stop, because the durability question a devbox has to answer is not "did
 * a closed file survive" but "did what the application flushed survive the
 * container that died holding the handle". The handle is never closed: the
 * process is killed with its container.
 */
function holdOpen(path: string, content: string, holdMs: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const handle = openSync(path, 'w');
  writeSync(handle, content);
  fsyncSync(handle);
  const releaseAt = Date.now() + holdMs;
  const tick = (): void => {
    if (Date.now() >= releaseAt) {
      closeSync(handle);
      return;
    }
    setTimeout(tick, 1_000);
  };
  tick();
}

/** What a command leaves behind. `hold` is the one outcome that is not an exit
 *  code: the open handle IS the observation, so the process stays alive until
 *  the container it belongs to is killed under it. */
type Outcome = { readonly kind: 'exit'; readonly code: number } | { readonly kind: 'hold' };

const exitWith = (code: number): Outcome => ({ kind: 'exit', code });

function main(argv: readonly string[]): Outcome {
  const command = argv[0] ?? '';
  const root = argument(argv, 'root', '/workspace/e2e');
  const seed = argument(argv, 'seed', 'devbox-e2e');
  if (command === 'small') {
    const written = materialise(smallPlan(root), seed);
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...written })}\n`);
    return exitWith(0);
  }
  if (command === 'npm') {
    const mib = Number.parseInt(argument(argv, 'mib', '30'), 10);
    const written = materialise(npmPlan(join(root, MID_SCALE_DIRECTORY), mib * 1_048_576), seed);
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...written })}\n`);
    return exitWith(0);
  }
  if (command === 'delete') {
    const removed: string[] = [];
    for (const name of argument(argv, 'paths', '').split(',').filter((entry) => entry.length > 0)) {
      const path = join(root, name);
      rmSync(path, { force: true });
      removed.push(name);
    }
    const present = removed.filter((name) => existsSync(join(root, name)));
    process.stdout.write(`${JSON.stringify({ ok: present.length === 0, command, removed, present })}\n`);
    return exitWith(present.length === 0 ? 0 : 1);
  }
  if (command === 'hold-open') {
    const path = join(root, argument(argv, 'path', 'open-write.bin'));
    const content = argument(argv, 'content', 'devbox-e2e-open-write');
    holdOpen(path, content, Number.parseInt(argument(argv, 'hold-ms', '1800000'), 10));
    process.stdout.write(`${JSON.stringify({ ok: true, command, path, bytes: content.length })}\n`);
    return { kind: 'hold' };
  }
  if (command === 'digest') {
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...digestTree(root) })}\n`);
    return exitWith(0);
  }
  if (command === 'absent') {
    // The DELETION half of the restore proof, asked as its own question so a
    // resurrected file is named rather than showing up as a digest mismatch.
    const back = argument(argv, 'paths', '')
      .split(',')
      .filter((entry) => entry.length > 0)
      .filter((name) => existsSync(join(root, name)));
    process.stdout.write(`${JSON.stringify({ ok: back.length === 0, command, resurrected: back })}\n`);
    return exitWith(back.length === 0 ? 0 : 1);
  }
  if (command === 'read') {
    const path = join(root, argument(argv, 'path', ''));
    const exists = existsSync(path);
    process.stdout.write(`${JSON.stringify({
      ok: exists,
      command,
      exists,
      bytes: exists ? statSync(path).size : 0,
      content: exists ? readFileSync(path, 'utf8').slice(0, 4_096) : '',
    })}\n`);
    return exitWith(exists ? 0 : 1);
  }
  process.stdout.write(`${JSON.stringify({ ok: false, error: `no such command: ${command}` })}\n`);
  return exitWith(2);
}

const outcome = main(process.argv.slice(2));
// A `hold` outcome deliberately falls off the end: the pending timer keeps this
// process — and therefore the open handle — alive. Exiting here is what an
// earlier draft did, and it closed the handle before the checkpoint that the
// open write is supposed to be measured across.
if (outcome.kind === 'exit') process.exit(outcome.code);
