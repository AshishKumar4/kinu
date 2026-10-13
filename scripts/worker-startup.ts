/**
 * The built Worker's startup, measured before it is uploaded: what every isolate links and evaluates before it can
 * answer. Cloudflare refuses a version whose startup exceeds its CPU limit (code 10021), and a refusal after a reset
 * leaves the target serving its placeholder (staging, 89759ebcc, 2026-10-13).
 *
 *   bun scripts/worker-startup.ts check <built wrangler.json>   measure, and fail above STARTUP_BOUND_MS
 *
 * What it measures, on this machine:
 * - `wrangler check startup` over the dry-run bundle, five times; the median of each profile's whole span. Its harness
 *   (wrangler 4.145 `analyseBundle`) imports the main module from a `startup()` function under the inspector: that
 *   frame's own time is the module loading the import does, linear in the bytes it links (a synthetic Worker of
 *   uncalled functions: 17.9 ms at 1.17 MB, 72.7 ms at 4.77 MB), and each module's top level is its own frame.
 * - The static closure: the bytes the main module links through static imports, which that loading time follows
 *   (17.2-18.0 µs a KiB over the three builds below).
 *
 * Calibrated 2026-10-13 on the workstation the deploy runs on, five profiles each:
 * - 26244c765, deployed on 2026-10-10: 235 ms (137 ms loading, 7,839 KiB linked).
 * - 89759ebcc, refused on staging: 254 ms (148 ms loading, 8,591 KiB).
 * - The local figure does not track the validator's linearly. Deployed seven times each to a scratch Worker,
 *   89759ebcc was refused twice and read 564-785 ms otherwise. Its cut, which links 6,981 KiB at 225 ms, was refused
 *   once and read 470-787 ms.
 * So the bound is the accepted build's figure: no build slower than one the validator took.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import * as v from 'valibot';

/** 26244c765's local startup, the newest build the validator accepted when this was set (see header). */
export const STARTUP_BOUND_MS = 235;

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

// A built chunk's static `import … from "./x.js"` and `export … from "./x.js"`, minified or not.
const STATIC_LINKS = [
  /(?:^|[;\n}])\s*import\s*(?:[\w*{}\s,$]+from\s*)?["']([^"']+)["']/gu,
  /export\s*(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/gu,
];

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

    for (const pattern of STATIC_LINKS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1] ?? '';

        if (specifier.startsWith('.')) pending.push(normalize(join(dirname(file), specifier)));
      }
    }
  }

  return { files: seen.size, bytes };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
};

/** A built Worker's startup on this machine: the medians over its profiles, each profile's span, and what it links. */
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
    totalMs: median(profiles.map((profile) => profile.totalMs)), loadingMs: median(profiles.map((profile) => profile.loadingMs)),
    runs: profiles.map((profile) => Math.round(profile.totalMs)), ...staticClosure(join(dirname(config), built.main)),
  };
}

if (import.meta.main) {
  const [command, path = ''] = process.argv.slice(2);

  if (command === 'check' && path !== '') {
    const measured = measure(path);

    const line = `startup ${measured.totalMs.toFixed(0)} ms median of ${measured.runs.join(', ')} (module loading ${measured.loadingMs.toFixed(0)} ms), `
      + `${(measured.bytes / 1024).toFixed(0)} KiB linked in ${String(measured.files)} files; bound ${String(STARTUP_BOUND_MS)} ms`;

    console.log(line);
    process.exit(measured.totalMs > STARTUP_BOUND_MS ? 1 : 0);
  }

  console.error('usage: bun scripts/worker-startup.ts check <built wrangler.json>');
  process.exit(2);
}
