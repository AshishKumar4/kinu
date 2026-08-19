// BackendHost is the loop contract the backends implement, so a member that no
// caller ever reaches is not a seam — it is a lie about where a capability
// lives. `resolveExtraTools` was exactly that: declared here, implemented as a
// pass-through by the CLI, absent on cf, and called by nobody, while each
// backend actually merged its MCP tools privately into its own turn config.
//
// This guards the whole interface against that class of drift: every declared
// member must be reached through a `host.` access somewhere in the monorepo.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = join(import.meta.dir, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path);
  }
  return out;
}

function declaredMembers(interfaceBody: string): string[] {
  return [...interfaceBody.matchAll(
    /^\s{2}(?:readonly\s+)?([a-zA-Z][a-zA-Z0-9]*)\??(?:<[^>]+>)?[(:]/gm,
  )].flatMap((match) => match[1] ? [match[1]] : []);
}

describe('BackendHost contract', () => {
  const source = readFileSync(join(PACKAGES, 'core', 'src', 'types', 'backend-host.ts'), 'utf8');
  const body = source.slice(source.indexOf('export interface BackendHost {'));
  const members = declaredMembers(body);

  test('declares the loop capabilities and nothing more', () => {
    expect(members.sort()).toEqual(
      ['broadcast', 'enqueueTurn', 'headRuntime', 'nodeHost', 'setTimer', 'turnInFlight'],
    );
  });

  test('every declared member is reached through a host reference', () => {
    const consumers = ['core', 'cf-backend', 'cli-backend', 'cli']
      .flatMap((pkg) => sourceFiles(join(PACKAGES, pkg, 'src')))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const unreachable = members.filter((m) => !new RegExp(`host\\.${m}\\b`).test(consumers));
    expect(unreachable).toEqual([]);
  });
});
