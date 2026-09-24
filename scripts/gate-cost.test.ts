import { describe, expect, test } from 'bun:test';
import { holdsCheckoutResource } from './gate-cost';

const CHECKOUT = '/home/dev/Kinu-wt-lane/';

// `/proc/<pid>/cmdline` separates arguments with NUL.
function argv(...words: string[]): string {
  return `${words.join('\0')}\0`;
}

describe('which Kinu work holds what a measured row needs', () => {
  test('this checkout\'s own pool, dev server or suite does, named by path or by working directory', () => {
    expect(holdsCheckoutResource({ command: argv('node', `${CHECKOUT}node_modules/.bin/vite`, 'dev') }, CHECKOUT)).toBe(true);
    expect(holdsCheckoutResource({ command: argv('bun', './node_modules/.bin/vitest', 'run'), cwd: `${CHECKOUT}packages/cf-backend` }, CHECKOUT)).toBe(true);
    expect(holdsCheckoutResource({ command: argv('bun', './node_modules/.bin/vitest', 'run'), cwd: CHECKOUT.slice(0, -1) }, CHECKOUT)).toBe(true);
  });

  test('another checkout\'s pool or dev server does not: its own processes and ports, only load here', () => {
    expect(holdsCheckoutResource({ command: argv('node', '/home/dev/Kinu-wt-other/node_modules/.bin/vite', 'dev', '--port', '5271') }, CHECKOUT)).toBe(false);
    expect(holdsCheckoutResource({ command: argv('bun', '/home/dev/Proteus/node_modules/vitest/vitest.mjs', 'run'), cwd: '/home/dev/Proteus' }, CHECKOUT)).toBe(false);
    // A sibling whose name extends this one's is another checkout.
    expect(holdsCheckoutResource({ command: argv('bun', './node_modules/.bin/vitest', 'run'), cwd: '/home/dev/Kinu-wt-lane2' }, CHECKOUT)).toBe(false);
  });

  test('an editor\'s language server in this checkout does not: it holds no pool and never exits', () => {
    expect(holdsCheckoutResource({ command: argv('node', `${CHECKOUT}node_modules/.bin/tsc`, '--lsp', '--stdio') }, CHECKOUT)).toBe(false);
  });
});
