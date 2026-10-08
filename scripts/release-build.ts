#!/usr/bin/env bun
/**
 * `bun scripts/release-build.ts <env> <sha> [--promote]`: the deploy's build, on armada at the exact commit
 * (scripts/release-build.sh), unpacked into packages/cf-backend/dist, its CLI release signed here, where the key is.
 * Nothing is compiled or bundled on this machine.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { connect } from 'armada';

const ROOT = join(import.meta.dir, '..');

const BACKEND = join(ROOT, 'packages', 'cf-backend');

const DIST = join(BACKEND, 'dist');

const UnsignedSchema = v.object({ version: v.string(), sha: v.string() });

async function main(): Promise<number> {
  const [target, sha, promote] = process.argv.slice(2);

  if ((target !== 'staging' && target !== 'production') || sha === undefined || (promote !== undefined && promote !== '--promote')) {
    process.stderr.write('usage: bun scripts/release-build.ts staging|production <sha> [--promote]\n');

    return 2;
  }

  const build = Bun.spawn([
    join(ROOT, 'node_modules', '.bin', 'armada'), 'map', `--commit=${sha}`, '--times=1', '--size=medium', '--timeout=1800', '--output',
    `--label=deploy build ${target} ${sha}`, '--', 'bash', 'scripts/release-build.sh', target, sha, ...promote === undefined ? [] : [promote],
  ], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });

  let said = '';

  for await (const chunk of build.stderr) {
    const text = new TextDecoder().decode(chunk);

    said += text;
    process.stderr.write(text);
  }

  const job = /^job (\S+)$/mu.exec(said)?.[1];

  if (await build.exited !== 0 || job === undefined) throw new Error(`the build on armada failed${job === undefined ? '' : ` (job ${job})`}`);
  const tarball = await connect().output(job, 0);

  if (tarball === null) throw new Error(`the build on armada (job ${job}) left no output`);
  rmSync(DIST, { recursive: true, force: true });
  rmSync(join(BACKEND, '.wrangler', 'deploy'), { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  const unpacked = Bun.spawnSync(['tar', '-xzf', '-', '-C', BACKEND], { stdin: tarball, stdout: 'pipe', stderr: 'pipe' });

  if (unpacked.exitCode !== 0) throw new Error(`unpacking the build of job ${job}: ${unpacked.stderr.toString().trim()}`);

  // Without it, `wrangler deploy` bundles the sources itself instead of publishing this build.
  if (!existsSync(join(BACKEND, '.wrangler', 'deploy', 'config.json'))) throw new Error(`the build of job ${job} holds no .wrangler/deploy/config.json`);
  console.log(`built ${target} ${sha} on armada, job ${job}: ${String(tarball.byteLength)} bytes`);

  if (promote !== undefined) return 0;
  const unsignedFile = join(DIST, 'release-unsigned.json');
  const unsigned = v.parse(UnsignedSchema, JSON.parse(readFileSync(unsignedFile, 'utf8')));
  const signed = Bun.spawnSync([join(ROOT, 'node_modules', '.bin', 'bun'), join(ROOT, 'scripts', 'sign-release.ts'), join(DIST, 'client', 'downloads'), unsigned.version, unsigned.sha], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });

  rmSync(unsignedFile);

  return signed.exitCode;
}

process.exitCode = await main();
