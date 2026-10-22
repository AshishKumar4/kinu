/**
 * Where an `eval` program runs (`programPlace`): one that imports from the workspace runs as Node there, every other in
 * the isolate, as before. Defends: a program that names no workspace module paying for a Node launch, and one that does
 * meeting the isolate's "No such module".
 */
import { describe, expect, test } from 'bun:test';
import { programPlace } from '../src/execution/program-place';

describe("an eval program's place", () => {
  test('runs in the isolate when it imports nothing, or only Node\'s own modules and Kinu\'s', () => {
    for (const code of [
      'return 1',
      "// Read the notes\nconst fs = require('fs/promises');\nreturn await fs.readFile('notes.md', 'utf8');",
      "const { join } = require('node:path'); return join('a', 'b');",
      "const path = await import('node:path'); return path.sep;",
      'const x = await workspace.exec("ls"); return x;',
    ]) expect(programPlace(code)).toEqual({ kind: 'isolate' });
  });

  test('runs on Node when it requires a workspace file or a package', () => {
    expect(programPlace("const lib = require('./lib.js'); return lib.x;").kind).toBe('node');
    expect(programPlace("const pad = require('left-pad'); return pad('a', 3);").kind).toBe('node');
    expect(programPlace("const m = await import('../shared/m.mjs'); return m.y;").kind).toBe('node');
  });

  test('runs on Node with every static import, which the isolate never ran, its declarations found where they are written', () => {
    const code = "// Sum\nimport { x } from './lib.mjs';\nimport { web } from 'kinu';\nreturn x + 1;";
    const place = programPlace(code);

    expect(place.kind).toBe('node');
    expect(place.kind === 'node' ? place.imports.map((declared) => [declared.specifier, code.slice(declared.start, declared.end)]) : []).toEqual([
      ['./lib.mjs', "import { x } from './lib.mjs';"], ['kinu', "import { web } from 'kinu';"],
    ]);
  });

  test('a program that does not parse stays in the isolate, which reports its syntax error as it always has', () => {
    expect(programPlace("const x: number = require('./a'); return x;")).toEqual({ kind: 'isolate' });
  });
});
