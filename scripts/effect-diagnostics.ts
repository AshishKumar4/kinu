/**
 * Effect diagnostics gate: the pinned `@effect/tsgo` language service over every typechecked
 * project that imports `effect`, red on any error-severity Effect diagnostic. The one that motivates
 * it is a floating effect: `Effect.succeed(x);` without `yield*` compiles, runs nothing, and no
 * `tsc` or syntax rule sees it.
 *
 * Its red half runs first. `scripts/fixtures/effect-diagnostics/planted.ts` holds a floating effect
 * and extends `tsconfig.base.json`, whose `plugins` entry turns the service on; the gate fails unless
 * the service reports that statement. A bump that stops reporting, or a base config that loses the
 * entry, fails here instead of passing as a clean tree. Owner decision, 2026-09-23.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';

import { assertMeasured, finding } from './gate-ratchet';
import { isParseable, readMatching } from './sources';

const root = new URL('..', import.meta.url).pathname;

const TOOL = fileURLToPath(new URL('./dist/effect-tsgo.cjs', import.meta.resolve('@effect/tsgo/package.json')));

const FIXTURE = 'scripts/fixtures/effect-diagnostics';

const DiagnosticSchema = v.object({
  file: v.string(),
  line: v.number(),
  severity: v.string(),
  name: v.string(),
  message: v.string(),
});

const ReportSchema = v.object({
  diagnostics: v.array(DiagnosticSchema),
  summary: v.object({ filesChecked: v.number(), totalFiles: v.number() }),
});

type Report = v.InferOutput<typeof ReportSchema>;

/** A typechecked project: its config, and the directory whose files it owns. */
export interface Project {
  readonly config: string;
  readonly directory: string;
}

function diagnose(project: Project): Report {
  const run = spawnSync(TOOL, ['diagnostics', '--project', `${root}${project.config}`, '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });

  if (run.error) throw new Error(`effect-diagnostics: could not run ${TOOL}`, { cause: run.error });

  if (run.stdout.trim().length === 0) throw new Error(`effect-diagnostics: ${project.config} produced no report: ${run.stderr}`);

  return v.parse(ReportSchema, JSON.parse(run.stdout));
}

/** The projects `bun run typecheck` compiles, from its own `-p` arguments. */
export function typecheckedProjects(manifest: string): readonly Project[] {
  const script = v.parse(v.object({ scripts: v.object({ typecheck: v.string() }) }), JSON.parse(manifest)).scripts.typecheck;

  return [...script.matchAll(/(?:^|\s)-p\s+(\S+)/gu)].flatMap((match) => {
    const argument = match[1] ?? '';

    if (argument.length === 0) return [];

    return argument.endsWith('.json')
      ? [{ config: argument, directory: argument.slice(0, argument.lastIndexOf('/')) }]
      : [{ config: `${argument}/tsconfig.json`, directory: argument }];
  });
}

/**
 * The projects owning a file that imports `effect`: each file goes to the project whose directory
 * holds it most closely. The planted fixture is the red half, run on its own, and owns no project.
 */
export function projectsImportingEffect(projects: readonly Project[], sources: ReadonlyMap<string, string>): readonly Project[] {
  const selected = new Set<Project>();

  for (const [file, text] of sources) {
    if (file.startsWith(`${FIXTURE}/`) || !/\bfrom ['"]effect(?:\/[^'"]*)?['"]/u.test(text)) continue;

    const owner = projects
      .filter(({ directory }) => file.startsWith(`${directory}/`))
      .sort((a, b) => b.directory.length - a.directory.length)[0];

    if (owner !== undefined) selected.add(owner);
  }

  return [...selected].sort((a, b) => a.config.localeCompare(b.config));
}

/** The line the planted statement sits on: the first line after its `// [floating]` marker. */
function plantedLine(): number {
  const lines = readFileSync(`${root}${FIXTURE}/planted.ts`, 'utf8').split('\n');
  const marker = lines.findIndex((line) => line.trim() === '// [floating]');

  if (marker < 0) throw new Error(`effect-diagnostics: ${FIXTURE}/planted.ts lost its [floating] marker`);

  return marker + 2;
}

export const BLIND_SPOTS: readonly string[] = [
  'WARNING AND SUGGESTION DIAGNOSTICS — NOT ENFORCED. Only error severity fails the gate; the pinned '
  + 'version\'s defaults decide which rules are errors, and the red half pins floatingEffect alone.',
  'A PROJECT OUTSIDE `bun run typecheck` — NOT CHECKED. Projects come from that script\'s `-p` list.',
  'A PROJECT THAT OVERRIDES `plugins` — NOT CHECKED. Every checked project must report files checked, '
  + 'so an override that silences one is red, but a project with no `effect` import is not run at all.',
];

if (import.meta.main) {
  const planted = diagnose({ config: `${FIXTURE}/tsconfig.json`, directory: FIXTURE });
  const line = plantedLine();

  const reported = planted.diagnostics.some((d) => d.name === 'floatingEffect' && d.severity === 'error'
    && d.file.endsWith(`${FIXTURE}/planted.ts`) && d.line === line);

  if (!reported) {
    console.error(finding({
      at: `${FIXTURE}/planted.ts:${String(line)}`,
      invariant: 'the pinned @effect/tsgo reports a floating effect as an error',
      found: `${String(planted.diagnostics.length)} diagnostic(s), none a floatingEffect error on that line`,
      silently: 'every project would pass this gate while a dropped effect compiles and runs nothing',
      fix: 'restore the `plugins` entry in tsconfig.base.json, or pin an @effect/tsgo that reports it',
    }));
    process.exit(1);
  }

  const projects = projectsImportingEffect(typecheckedProjects(readFileSync(`${root}package.json`, 'utf8')), readMatching(isParseable));
  const findings: string[] = [];
  let checked = 0;

  for (const project of projects) {
    const report = diagnose(project);

    if (report.summary.filesChecked === 0) {
      findings.push(finding({
        at: project.config,
        invariant: 'a project that imports `effect` is checked by the Effect language service',
        found: `0 of ${String(report.summary.totalFiles)} files checked`,
        silently: 'the project passes with its Effect code unread',
        fix: 'let the project inherit `plugins` from tsconfig.base.json',
      }));
    }

    checked += report.summary.filesChecked;

    // The planted statement is the red half's finding; a project that also holds it does not own it.
    for (const diagnostic of report.diagnostics.filter((d) => d.severity === 'error' && !d.file.includes(`/${FIXTURE}/`))) {
      findings.push(finding({
        at: `${diagnostic.file.replace(root, '')}:${String(diagnostic.line)}`,
        invariant: 'no error-severity Effect diagnostic',
        found: `${diagnostic.name}: ${diagnostic.message}`,
        silently: 'the effect is built and never runs, or runs with a requirement nothing provides',
        fix: 'yield the effect, or assign and use it',
      }));
    }
  }

  const summary = assertMeasured('effect-diagnostics', [
    ['planted diagnostics', planted.diagnostics.length],
    ['projects importing effect', projects.length],
    ['files checked', checked],
  ]);

  if (findings.length > 0) {
    console.error(`effect-diagnostics: ${String(findings.length)} finding(s)\n`);

    for (const text of findings) console.error(text);
    process.exit(1);
  }

  console.log(`effect-diagnostics: ok — the planted floating effect is reported, and `
    + `${projects.map(({ config }) => config).join(', ')} have no error-severity Effect diagnostic, over ${summary}`);

  for (const spot of BLIND_SPOTS) console.log(`  blind: ${spot}`);
}
