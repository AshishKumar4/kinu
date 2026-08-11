/**
 * The `run` interceptor for hand-rolled file edits.
 *
 * The `file` tool's spec says not to change files by pointing `run` at
 * `sed -i`, a heredoc, or an inline python/perl script, because those write
 * whether or not the text they aimed at was there. It says so for a real
 * reason — a missed anchor in an in-place edit is a silent corruption nobody
 * reads until much later — and it is up against a habit: across 789 `run`
 * calls in the preserved tb20/tb21 trajectories, 25% carried a heredoc, 36
 * used `sed -i`, and 104 ran an inline interpreter. Prose is the wrong
 * instrument for a habit that strong; Proteus's own telemetry puts written
 * doctrine at roughly 0% conversion and a mechanical splice at ~24%, which is
 * why turn-steering.ts and the completion gate exist. This is the same move
 * for the same reason, at the one place the trigger is observable: the command
 * string itself.
 *
 * It STEERS, it does not block. The command runs, its output comes back whole,
 * and a note rides along naming `file` and what it does differently. Refusing
 * a shell command would cap a capability to enforce a preference, and the
 * matcher is a regex over an unparsed shell string — a false positive must
 * cost one sentence, never a failed command. (Contrast safety/approval-gate.ts,
 * which does refuse: that one guards against destroying the machine.)
 *
 * `file` is built unconditionally beside `run` in the same factory, so the
 * note can never name a tool the caller does not have.
 */

/** One way of writing a file through the shell that `file` does safely. */
interface Rule {
  /** Named in the note, so the model is told which shape it just used. */
  readonly name: string;
  readonly pattern: RegExp;
  /** Additional evidence the command really writes, for shapes whose
   *  headline pattern is also a normal read (an inline script, a heredoc). */
  readonly writes?: RegExp;
}

/** In-place stream editors, heredocs landing in a file, and inline
 *  interpreter scripts that open one for writing. The three shapes measured in
 *  the corpus; each is an unconditional write with no anchor check. */
const RULES: readonly Rule[] = [
  {
    name: 'an in-place stream edit',
    // `sed -i`, `-i.bak`, `-ri`, `--in-place`, and the perl/ruby equivalents.
    // The option-cluster form is why this is not a literal `-i` match.
    pattern: /\b(?:sed|perl|ruby)\s+(?:-\S+\s+)*(?:--in-place|-[a-zA-Z]*i[a-zA-Z]*)(?=[\s.'"=]|$)/,
  },
  {
    name: 'a heredoc written to a file',
    // `cat > f <<EOF`, `cat <<'EOF' > f`, `tee f <<EOF`. A heredoc feeding a
    // program (`python3 <<EOF`) is a script, not a file edit, so the write
    // evidence is the redirect or `tee` that lands it on disk.
    pattern: /<<-?\s*['"]?[A-Za-z_]\w*/,
    writes: /(?:^|[\s|;&])(?:>>?\s*\S|tee\b)/,
  },
  {
    name: 'an inline interpreter script',
    // `python3 -c`, `perl -e`, `node -e`. Only when the code itself opens a
    // file for writing — an inline script that computes something is exactly
    // what `run` is for.
    pattern: /\b(?:python3?|perl|ruby|node|deno)\s+(?:-\S+\s+)*-(?:c|e)\b/,
    writes: /open\s*\([^)]*['"][wax]|write_text\s*\(|writeFileSync\s*\(|\bprint\s*\([^)]*file\s*=|>>?\s*['"]?[\w./-]+\.\w/,
  },
];

/**
 * The shape of hand-rolled file write this command uses, or null. Named rather
 * than boolean so the note can say which one, which is what makes it concrete
 * enough to act on.
 */
export function handRolledFileWrite(command: string): string | null {
  for (const rule of RULES) {
    if (!rule.pattern.test(command)) continue;
    if (rule.writes && !rule.writes.test(command)) continue;
    return rule.name;
  }
  return null;
}

/** The note, prepended to the command's own output. */
export function fileToolSteer(command: string): string | null {
  const shape = handRolledFileWrite(command);
  return shape === null ? null : `[Proteus note: that command used ${shape}. `
    + 'The `file` tool changes files by exact text match and refuses when its anchor is missing or occurs more than once, '
    + 'where a shell rewrite lands either way and reports success. This command ran as written; reach for `file` for the next edit.]';
}
