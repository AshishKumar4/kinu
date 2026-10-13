/**
 * The built Worker's startup, measured before it is uploaded: what every isolate links and evaluates before it can
 * answer. Cloudflare refuses a version whose startup exceeds its CPU limit (code 10021), and a refusal after a reset
 * leaves the target serving its placeholder (staging, 89759ebcc, 2026-10-13).
 *
 *   bun scripts/worker-startup.ts check <built wrangler.json>   measure, and fail above STARTUP_BOUND_MS
 *
 * What it measures, on this machine:
 * - `wrangler check startup` over the dry-run bundle, five times; the fastest profile's whole span, since load on the
 *   machine only ever adds to it. Its harness (wrangler 4.145 `analyseBundle`) imports the main module from a
 *   `startup()` function under the inspector: that frame's own time is the module loading the import does, linear in
 *   the bytes it links (a synthetic Worker of uncalled functions: 17.9 ms at 1.17 MB, 72.7 ms at 4.77 MB), and each
 *   module's top level is its own frame.
 * - The static closure: the bytes the main module links through static imports, which that loading time follows
 *   (17-18 µs a KiB over the builds below).
 *
 * Calibrated 2026-10-13 on the workstation the deploy runs on. Each build has five local profiles (fastest / median),
 * then the validator's readings from interleaved deploys to scratch Workers (refusals; median of the rest):
 * - 89759ebcc, 8,591 KiB linked: 253 / 254 ms; refused 5 in 21, median 614 ms. Staging refused it too.
 * - 26244c765, 7,839 KiB: 231 / 235 ms; deployed on 2026-10-10. Not deployed to the scratch Workers.
 * - 1e588c64d, 6,981 KiB: 223 / 227 ms; refused 2 in 36, median 512 ms.
 * - 3b9c58d4c, 6,533 KiB: 209 / 213 ms; refused 0 in 15, median 460 ms (427-861).
 * The bound lies between the slowest build never refused and the fastest one refused: a build at 1e588c64d's figure
 * is refused often enough to take a deploy's target down at random.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { parseSync } from 'oxc-parser';
import * as v from 'valibot';

/** Between 3b9c58d4c's 209 ms, never refused, and 1e588c64d's 223 ms, refused 2 in 36 (see header). */
export const STARTUP_BOUND_MS = 216;

const PROFILES = 5;

const ProfileSchema = v.object({
  startTime: v.number(),
  endTime: v.number(),
  nodes: v.array(v.object({ id: v.number(), callFrame: v.object({ functionName: v.string(), url: v.string() }) })),
  samples: v.array(v.number()),
  timeDeltas: v.array(v.number()),
});

export type StartupProfile = v.InferOutput<typeof ProfileSchema>;

/** A profile's whole span and its module loading, in ms. */
export interface ProfileTimes {
  readonly totalMs: number;
  readonly loadingMs: number;
}

/** One startup profile: its whole span, and the harness's own `startup()` frame, the module loading the import does. */
export function profileTimes(profile: StartupProfile): ProfileTimes {
  const harness = new Set(profile.nodes.filter((node) => node.callFrame.functionName === 'startup').map((node) => node.id));
  let loading = 0;

  // A sample's time is the delta to the next one (the Chrome profile convention).
  for (const [index, id] of profile.samples.entries()) {
    if (harness.has(id)) loading += profile.timeDeltas[index + 1] ?? 0;
  }

  return { totalMs: (profile.endTime - profile.startTime) / 1000, loadingMs: loading / 1000 };
}

/** What a Worker's startup links: the files and their bytes. */
export interface LinkedClosure {
  readonly files: number;
  readonly bytes: number;
}

/** The files a built module links through static imports and re-exports, itself included; `import()` links nothing. */
export function staticClosure(main: string): LinkedClosure {
  const seen = new Set<string>();
  const pending = [normalize(main)];
  let bytes = 0;

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');

    bytes += Buffer.byteLength(source);
    const { module } = parseSync(file, source);

    // A static import or re-export links its module; `import()` (`module.dynamicImports`) links nothing.
    const linked = [
      ...module.staticImports.map((entry) => entry.moduleRequest.value),
      ...module.staticExports.flatMap((entry) => entry.entries.flatMap((exported) => (exported.moduleRequest === null ? [] : [exported.moduleRequest.value]))),
    ];

    for (const specifier of linked) {
      if (specifier.startsWith('.')) pending.push(normalize(join(dirname(file), specifier)));
    }
  }

  return { files: seen.size, bytes };
}

/** A built Worker's startup on this machine: the fastest of its profiles, each profile's span, and what it links. */
interface MeasuredStartup extends LinkedClosure, ProfileTimes {
  readonly runs: readonly number[];
}

function measure(config: string): MeasuredStartup {
  const built = v.parse(v.object({ main: v.string() }), JSON.parse(readFileSync(config, 'utf8')));
  const scratch = mkdtempSync(join(tmpdir(), 'kinu-startup-'));
  const bundle = join(scratch, 'worker.bundle');
  const wrangler = (args: readonly string[]) => execFileSync('npx', ['wrangler', ...args], { cwd: dirname(config), stdio: ['ignore', 'ignore', 'inherit'] });

  wrangler(['deploy', '--dry-run', '--config', config, '--outfile', bundle]);

  const profiles = Array.from({ length: PROFILES }, (_, index) => {
    const out = join(scratch, `startup-${String(index)}.cpuprofile`);

    wrangler(['check', 'startup', '--worker', bundle, '--outfile', out]);

    return profileTimes(v.parse(ProfileSchema, JSON.parse(readFileSync(out, 'utf8'))));
  });

  return {
    totalMs: Math.min(...profiles.map((profile) => profile.totalMs)), loadingMs: Math.min(...profiles.map((profile) => profile.loadingMs)),
    runs: profiles.map((profile) => Math.round(profile.totalMs)), ...staticClosure(join(dirname(config), built.main)),
  };
}

if (import.meta.main) {
  const [command, path = ''] = process.argv.slice(2);

  if (command === 'check' && path !== '') {
    const measured = measure(path);

    const line = `startup ${measured.totalMs.toFixed(0)} ms, the fastest of ${measured.runs.join(', ')} (module loading ${measured.loadingMs.toFixed(0)} ms), `
      + `${(measured.bytes / 1024).toFixed(0)} KiB linked in ${String(measured.files)} files; bound ${String(STARTUP_BOUND_MS)} ms`;

    console.log(line);
    process.exit(measured.totalMs > STARTUP_BOUND_MS ? 1 : 0);
  }

  console.error('usage: bun scripts/worker-startup.ts check <built wrangler.json>');
  process.exit(2);
}
