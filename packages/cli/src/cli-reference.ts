/**
 * The CLI reference in `docs/CLI.md`, rendered from the command registry.
 *
 * Hand-written CLI docs drift the day someone adds a flag. This renders the
 * same walk `--help` renders (`commandEntries`), so a command or option that
 * exists is documented and one that does not cannot be. `bun run docs:cli`
 * writes the file; a test fails when the checked-in copy is stale.
 */

import type { Command, Option } from 'commander';
import { commandEntries, GLOBAL_ENVIRONMENT, HELP_EXAMPLES } from './display.js';

const DISCLAIMER =
  '> Maintained by Claude (AI-edited documentation, presented as-is); '
  + 'verify against the code when precision matters.';

export function renderCliReference(program: Command): string {
  const entries = commandEntries(program);
  const headings = [...new Set(entries.map((e) => e.heading))];
  const lines: string[] = [
    '# Proteus CLI reference',
    '',
    DISCLAIMER,
    '>',
    '> Generated from the command registry (`packages/cli/src/program.ts`) by',
    '> `bun run docs:cli`. Edit the registration, not this file.',
    '',
    `${program.description()}.`,
    '',
    '```',
    'proteus <command> [options]',
    '```',
    '',
    '## Commands',
    '',
  ];

  for (const heading of headings) {
    lines.push(`### ${heading.replace(/:$/, '')}`, '');
    lines.push('| Command | What it does |', '| --- | --- |');
    for (const entry of entries.filter((e) => e.heading === heading)) {
      lines.push(`| [\`proteus ${entry.term}\`](#${anchor(entry.term)}) | ${escapeCell(entry.description)} |`);
    }
    lines.push('');
  }

  lines.push('## Reference', '');
  for (const entry of entries) {
    lines.push(`### proteus ${entry.term}`, '');
    if (entry.description) lines.push(`${entry.description}.`, '');
    const aliases = entry.command.aliases();
    if (aliases.length > 0) {
      lines.push(`Also: ${aliases.map((a) => `\`proteus ${a}\``).join(', ')}`, '');
    }
    const options = visibleOptions(entry.command);
    if (options.length > 0) {
      lines.push('| Option | What it does |', '| --- | --- |');
      for (const option of options) {
        lines.push(`| \`${option.flags}\` | ${escapeCell(optionText(option))} |`);
      }
      lines.push('');
    }
  }

  lines.push('## Environment', '');
  lines.push('These apply to every command.', '');
  lines.push('| Variable | What it does |', '| --- | --- |');
  for (const [name, description] of GLOBAL_ENVIRONMENT) {
    lines.push(`| \`${name}\` | ${escapeCell(description)} |`);
  }
  lines.push('');

  lines.push('## Examples', '', '```bash');
  for (const example of HELP_EXAMPLES) lines.push(example);
  lines.push('```', '');
  return lines.join('\n');
}

/** Options a user can actually type: the hidden ones are internal plumbing. */
function visibleOptions(command: Command): Option[] {
  return command.options.filter((option) => !option.hidden);
}

function optionText(option: Option): string {
  const parts = [option.description];
  if (option.defaultValue !== undefined) parts.push(`(default: ${JSON.stringify(option.defaultValue)})`);
  return parts.filter(Boolean).join(' ');
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function anchor(term: string): string {
  return `proteus-${term}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
}
