import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { ALLOWED_INSTALL_SCRIPTS, declaredInstallScripts, judgeInstallScripts } from './install-scripts-gate';

const REPO = new URL('..', import.meta.url).pathname;

/** A synthetic `node_modules` holding every allowed package with a hook, plus
 *  whatever the case adds. The allowed set must be present for a clean verdict,
 *  because an allowed package that declares nothing is itself a finding. */
function modulesWith(extra: Readonly<Record<string, readonly string[]>>): string {
  const modules = join(scratchDir('install-scripts'), 'node_modules');

  const hooks = {
    ...Object.fromEntries(Object.keys(ALLOWED_INSTALL_SCRIPTS).map((name) => [name, ['postinstall']])),
    ...extra,
  } satisfies Readonly<Record<string, readonly string[]>>;

  for (const [name, lifecycle] of Object.entries(hooks)) {
    mkdirSync(join(modules, name), { recursive: true });
    writeFileSync(join(modules, name, 'package.json'), JSON.stringify({
      name, scripts: Object.fromEntries(lifecycle.map((hook) => [hook, 'node install.js'])),
    }));
  }

  return modules;
}

describe('install-scripts — the set that executes is a decision', () => {
  test('an unlisted package whose hook bun runs is the finding', () => {
    const { findings, ran } = judgeInstallScripts(modulesWith({ sneaky: ['postinstall'] }), REPO, new Set());

    expect(ran).toContain('sneaky');
    expect(findings.map((f) => f.pkg)).toEqual(['sneaky']);
    expect(findings[0]?.detail).toContain('EXECUTES postinstall');
  });

  test('the same package, blocked by bun, is not a finding and did not run', () => {
    const { findings, ran, blocked } = judgeInstallScripts(
      modulesWith({ sneaky: ['preinstall', 'postinstall'] }), REPO, new Set(['sneaky']),
    );

    expect(blocked).toEqual(['sneaky']);
    expect(ran).not.toContain('sneaky');
    expect(findings).toEqual([]);
  });

  test('an allowed package that no longer declares a hook is a stale entry', () => {
    const modules = modulesWith({});
    writeFileSync(join(modules, 'puppeteer', 'package.json'), JSON.stringify({ name: 'puppeteer' }));
    const { findings } = judgeInstallScripts(modules, REPO, new Set());

    expect(findings.map((f) => f.pkg)).toEqual(['puppeteer']);
    expect(findings[0]?.detail).toContain('no longer declares');
  });

  test('a repo-level trustedDependencies grant without a recorded reason is a finding', () => {
    const root = scratchDir('install-scripts-root');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', trustedDependencies: ['sneaky'] }));
    const { findings } = judgeInstallScripts(modulesWith({}), root, new Set());

    expect(findings.map((f) => f.pkg)).toEqual(['sneaky']);
    expect(findings[0]?.detail).toContain('trustedDependencies');
  });

  test('a scoped package is enumerated under its scope', () => {
    const modules = modulesWith({});
    mkdirSync(join(modules, '@scope', 'inner'), { recursive: true });
    writeFileSync(join(modules, '@scope', 'inner', 'package.json'), JSON.stringify({
      name: '@scope/inner', scripts: { install: 'true' },
    }));

    expect(declaredInstallScripts(modules).map((d) => d.pkg)).toContain('@scope/inner');
  });

  test('the allowed set alone, all executing, is the green verdict', () => {
    const { findings, ran, declared } = judgeInstallScripts(modulesWith({}), REPO, new Set());

    expect(declared.length).toBe(Object.keys(ALLOWED_INSTALL_SCRIPTS).length);
    expect([...ran].sort()).toEqual(Object.keys(ALLOWED_INSTALL_SCRIPTS).sort());
    expect(findings).toEqual([]);
  });
});

describe('install-scripts — the live tree', () => {
  test('installed dependencies declare hooks, bun blocks some, and every executing one is allowed', () => {
    const { declared, findings } = judgeInstallScripts();

    expect(declared.length).toBeGreaterThan(0);
    expect(findings).toEqual([]);
  });
});
