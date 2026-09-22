/**
 * `shell` interceptor for hand-rolled file edits (`sed -i`, heredocs, inline scripts).
 * Steers, never blocks: the regex matcher can false-positive, so a match costs one note, not a failed command.
 */

interface Rule {
  /** Named in the note. */
  readonly name: string;
  readonly pattern: RegExp;
  /** Extra evidence the command writes, for shapes whose pattern is also a normal read. */
  readonly writes?: RegExp;
}

const RULES: readonly Rule[] = [
  {
    name: 'an in-place stream edit',
    // Option clusters (`-ri`, `-i.bak`) are why this is not a literal `-i` match.
    pattern: /\b(?:sed|perl|ruby)\s+(?:-\S+\s+)*(?:--in-place|-[a-zA-Z]*i[a-zA-Z]*)(?=[\s.'"=]|$)/,
  },
  {
    name: 'a heredoc written to a file',
    // A heredoc feeding a program is a script; the write evidence is the redirect or `tee`.
    pattern: /<<-?\s*['"]?[A-Za-z_]\w*/,
    writes: /(?:^|[\s|;&])(?:>>?\s*\S|tee\b)/,
  },
  {
    name: 'an inline interpreter script',
    // Only when the code opens a file for writing.
    pattern: /\b(?:python3?|perl|ruby|node|deno)\s+(?:-\S+\s+)*-(?:c|e)\b/,
    writes: /open\s*\([^)]*['"][wax]|write_text\s*\(|writeFileSync\s*\(|\bprint\s*\([^)]*file\s*=|>>?\s*['"]?[\w./-]+\.\w/,
  },
];

/** Which hand-rolled file write this command uses, or null. */
export function handRolledFileWrite(command: string): string | null {
  for (const rule of RULES) {
    if (!rule.pattern.test(command)) continue;

    if (rule.writes && !rule.writes.test(command)) continue;

    return rule.name;
  }

  return null;
}

export function fileToolSteer(command: string): string | null {
  const writeMethod = handRolledFileWrite(command);

  return writeMethod === null ? null : `[Kinu note: that command used ${writeMethod}. `
    + 'The `file` tool changes files by exact text match and refuses when its anchor is missing or occurs more than once, '
    + 'where a shell rewrite lands either way and reports success. This command ran as written; reach for `file` for the next edit.]';
}

/**
 * Each writeMethod's note fires once per closure; `buildBuiltinTools` builds one per turn, so once per turn.
 */
export function createFileToolSteer(): (command: string) => string | null {
  const noted = new Set<string>();

  return (command) => {
    const writeMethod = handRolledFileWrite(command);

    if (writeMethod === null || noted.has(writeMethod)) return null;
    noted.add(writeMethod);

    return fileToolSteer(command);
  };
}
