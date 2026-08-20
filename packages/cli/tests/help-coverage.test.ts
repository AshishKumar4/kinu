import { describe, expect, test } from 'bun:test';
import type { Command } from 'commander';
import { buildProgram } from '../src/program';
import { renderHelp } from '../src/display';

/** Every runnable path in the registered tree, as the user would type it. */
function registeredPaths(cmd: Command, prefix = ''): string[] {
  return cmd.commands.flatMap((sub) => {
    const path = `${prefix}${sub.name()}`;
    return sub.commands.length > 0 ? registeredPaths(sub, `${path} `) : [path];
  });
}

function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

describe('root help', () => {
  const program = buildProgram();
  const help = stripAnsi(renderHelp(program));

  test('lists every registered command', () => {
    const missing = registeredPaths(program).filter(
      (path) => !new RegExp(`^\\s{2}${path.replace(/ /g, '\\s')}(\\s|$)`, 'm').test(help),
    );
    expect(missing).toEqual([]);
  });

  test('registers a non-trivial surface (the check above is not vacuous)', () => {
    expect(registeredPaths(program).length).toBeGreaterThan(40);
  });

  test('groups every command under a heading', () => {
    expect(help).not.toContain('Other commands:');
  });

  test('shows usage, options and environment', () => {
    expect(help).toContain('Usage:  kinu <command> [options]');
    expect(help).toContain('-v, --version');
    expect(help).toContain('KINU_HOME');
  });
});
