import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '@kinu.run/test-utils';
import { profileTimes, staticClosure, type StartupProfile } from './worker-startup';

describe("the built Worker's startup", () => {
  // wrangler's harness imports the main module from its own `startup()`: that frame's samples are the module loading,
  // and a module's top level is a frame of its own.
  test("a profile's span, and the time its samples spent in the harness's startup frame", () => {
    const profile: StartupProfile = {
      startTime: 1_000, endTime: 251_000,
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '' } },
        { id: 2, callFrame: { functionName: 'startup', url: '5f0c' } },
        { id: 3, callFrame: { functionName: '', url: 'file:///index.js' } },
      ],
      samples: [2, 2, 3, 2],
      timeDeltas: [0, 40_000, 60_000, 30_000],
    };

    // Each sample holds the time to the next: 40 + 60 ms in the harness's frame, 30 ms in the module's, the last none.
    expect(profileTimes(profile)).toEqual({ totalMs: 250, loadingMs: 100 });
  });

  test('the static closure follows imports and re-exports, never an import()', () => {
    const dist = scratchDir('worker-startup-closure');

    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.js'), 'import{a}from"./assets/a.js";export{b}from"./assets/b.js";const c=()=>import("./assets/c.js");\n');
    writeFileSync(join(dist, 'assets', 'a.js'), 'import"./shared.js";export const a=1;\n');
    writeFileSync(join(dist, 'assets', 'b.js'), 'import{s}from"./shared.js";export const b=s;\n');
    writeFileSync(join(dist, 'assets', 'shared.js'), 'export const s=2;\n');
    writeFileSync(join(dist, 'assets', 'c.js'), `export const c="${'x'.repeat(1000)}";\n`);

    const closure = staticClosure(join(dist, 'index.js'));

    expect(closure.files).toBe(4);
    expect(closure.bytes).toBeLessThan(1000);
  });
});
