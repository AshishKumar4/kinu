/**
 * The built Worker's startup, measured before it is uploaded: what every isolate links and evaluates before it can
 * answer. Cloudflare refuses a version whose startup exceeds its CPU limit (code 10021), and a refusal after a reset
 * leaves the target serving its placeholder (staging, 89759ebcc, 2026-10-13).
 *
 *   bun scripts/worker-startup.ts check <built wrangler.json>   measure, and fail above LINKED_BOUND_KIB
 *
 * What it measures, on this machine:
 * - The static closure: the bytes the main module links through static imports and re-exports, which every isolate
 *   loads before it answers. It is exact, the same for the same build on any run, and it is what the gate bounds.
 * - `wrangler check startup` over the dry-run bundle, five times, reported and not gated. Its harness (wrangler 4.145
 *   `analyseBundle`) imports the main module from a `startup()` function under the inspector: that frame's own time
 *   is the module loading the import does, linear in the bytes linked (a synthetic Worker of uncalled functions: 17.9
 *   ms at 1.17 MB, 72.7 ms at 4.77 MB; 17-18 µs a KiB over the builds below), and each module's top level is its own
 *   frame. Profiled 30 times each, interleaved, the fastest of five ran 204-243 ms for 3b9c58d4c and 223-249 ms for
 *   1e588c64d: under load the two overlap, so a time bound between them passes and fails the same build by chance.
 *
 * Calibrated 2026-10-13. Each build: its static closure; the median and range of its 30 local profiles; the
 * validator's readings from interleaved deploys to scratch Workers (refusals; median of the rest).
 * - 89759ebcc: 8,591 KiB; 263 ms (252-390); refused 5 in 21, median 614 ms. Staging refused it too.
 * - 26244c765: 7,839 KiB; 240 ms (232-546); deployed on 2026-10-10, not deployed to the scratch Workers.
 * - 1e588c64d: 6,981 KiB; 233 ms (223-401); refused 2 in 36, median 512 ms.
 * - 3b9c58d4c: 6,533 KiB; 212 ms (204-291); refused 0 in 15, median 460 ms (427-861).
 * The bound sits between the build never refused and the smallest one refused, with room for the first's growth.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { parseSync } from 'oxc-parser';
import * as v from 'valibot';

/** Between 3b9c58d4c's 6,533 KiB, never refused, and 1e588c64d's 6,981 KiB, refused 2 in 36 (see header). */
export const LINKED_BOUND_KIB = 6750;

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
      + `${(measured.bytes / 1024).toFixed(0)} KiB linked in ${String(measured.files)} files; bound ${String(LINKED_BOUND_KIB)} KiB linked`;

    console.log(line);
    process.exit(measured.bytes / 1024 > LINKED_BOUND_KIB ? 1 : 0);
  }

  console.error('usage: bun scripts/worker-startup.ts check <built wrangler.json>');
  process.exit(2);
}
