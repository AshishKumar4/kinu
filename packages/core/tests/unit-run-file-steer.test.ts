// The `run` interceptor for hand-rolled file edits.
//
// `file`'s spec prohibits changing files by pointing `run` at sed -i, a
// heredoc, or an inline script — those write whether or not the text they
// aimed at was there. The corpus says what that prohibition is up against: a
// 25% base rate of exactly those shapes across 789 `run` calls, against prose
// our own telemetry rates near 0% conversion. So the policy is also a
// mechanism. It STEERS and never blocks: the contract these tests pin is that
// the command runs, its output arrives whole, and a note names `file`.
import { describe, test, expect } from 'bun:test';
import { handRolledFileWrite, fileToolSteer, createFileToolSteer } from '../src/tools/run-file-steer.js';
import { buildBuiltinTools } from '../src/tools/builtins.js';
import { createTestRuntime } from './helpers.js';
import type { AgentRuntime, Shell } from '../src/types/agent-runtime.js';

type RunTool = { execute: (args: { command: string; runtime?: string }) => Promise<string> };

const echoShell = (): Shell => ({
  exec: async (command: string) => ({ stdout: `ran: ${command}`, stderr: '', exitCode: 0 }),
});

const runToolOver = (shell: Shell): RunTool => {
  const { rt } = createTestRuntime();
  return buildBuiltinTools({ rt: { ...rt, shell } as AgentRuntime }).run as unknown as RunTool;
};

describe('handRolledFileWrite', () => {
  test('names the in-place stream edits, in every option spelling', () => {
    for (const command of [
      "sed -i 's/old/new/' src/app.ts",
      "sed -i.bak 's/old/new/g' src/app.ts",
      "sed -ri 's/(a)/\\1b/' f",
      "sed --in-place 's/a/b/' f",
      "sed -i -e 's/a/b/' -e 's/c/d/' f",
      "perl -pi -e 's/a/b/' f",
    ]) {
      expect(handRolledFileWrite(command)).toBe('an in-place stream edit');
    }
  });

  test('names a heredoc only once it lands on disk', () => {
    expect(handRolledFileWrite("cat > config.json <<'EOF'\n{}\nEOF")).toBe('a heredoc written to a file');
    expect(handRolledFileWrite("cat <<EOF >> notes.md\nhello\nEOF")).toBe('a heredoc written to a file');
    expect(handRolledFileWrite("tee /etc/hosts <<EOF\n127.0.0.1 x\nEOF")).toBe('a heredoc written to a file');
    // A heredoc feeding a program is a script, not a file edit.
    expect(handRolledFileWrite('python3 <<EOF\nprint(sum(range(10)))\nEOF')).toBeNull();
  });

  test('names an inline script only when the script itself opens a file for writing', () => {
    expect(handRolledFileWrite(`python3 -c "open('f.txt','w').write('x')"`))
      .toBe('an inline interpreter script');
    expect(handRolledFileWrite(`python3 -c "from pathlib import Path; Path('f').write_text('x')"`))
      .toBe('an inline interpreter script');
    expect(handRolledFileWrite(`node -e "require('fs').writeFileSync('f','x')"`))
      .toBe('an inline interpreter script');
    // Computation is exactly what `run` is for.
    expect(handRolledFileWrite(`python3 -c "print(1+1)"`)).toBeNull();
    expect(handRolledFileWrite(`node -e "console.log(process.version)"`)).toBeNull();
  });

  test('leaves ordinary commands alone — a false positive must cost nothing', () => {
    for (const command of [
      'ls -la',
      'npm test',
      "grep -i needle haystack.txt",
      "sed -n '10,20p' src/app.ts",
      "sed -e 's/a/b/' input > output",
      'git diff --stat',
      'sort -i names.txt',
      'cat README.md',
    ]) {
      expect(handRolledFileWrite(command)).toBeNull();
    }
  });
});

describe('the run tool', () => {
  test('runs the command anyway and returns its output whole, with the steer attached', async () => {
    const run = runToolOver(echoShell());
    const out = await run.execute({ command: "sed -i 's/a/b/' src/app.ts" });
    expect(out).toContain("ran: sed -i 's/a/b/' src/app.ts");
    expect(out).toContain('`file`');
    expect(out).toContain('an in-place stream edit');
    expect(out).toContain('refuses when its anchor is missing or occurs more than once');
  });

  test('says nothing on a command that does not hand-roll a write', async () => {
    const run = runToolOver(echoShell());
    const out = await run.execute({ command: 'npm test' });
    expect(out).toBe('ran: npm test');
  });

  test('is a steer, never a block: the note names the alternative and nothing is refused', () => {
    const steer = fileToolSteer("sed -i 's/a/b/' f");
    expect(steer).not.toBeNull();
    expect(steer).not.toMatch(/blocked|denied|refus(ed|ing) to run|not allowed/i);
    expect(steer).toContain('This command ran as written');
  });

  test('a shape repeated in one turn is noted once, and the output still arrives whole', async () => {
    const run = runToolOver(echoShell());
    const first = await run.execute({ command: "sed -i 's/a/b/' one.ts" });
    const second = await run.execute({ command: "sed -i 's/c/d/' two.ts" });
    expect(first).toContain('an in-place stream edit');
    expect(second).not.toContain('Proteus note');
    expect(second).toBe("ran: sed -i 's/c/d/' two.ts");
  });

  test('a different shape in the same turn still gets its own note', async () => {
    const run = runToolOver(echoShell());
    await run.execute({ command: "sed -i 's/a/b/' one.ts" });
    const heredoc = await run.execute({ command: "cat > f.json <<'EOF'\n{}\nEOF" });
    expect(heredoc).toContain('a heredoc written to a file');
  });

  test('the next turn starts fresh — a new toolset has said nothing yet', async () => {
    await runToolOver(echoShell()).execute({ command: "sed -i 's/a/b/' one.ts" });
    const nextTurn = await runToolOver(echoShell()).execute({ command: "sed -i 's/a/b/' one.ts" });
    expect(nextTurn).toContain('an in-place stream edit');
  });
});

describe('createFileToolSteer — once per shape, per turn', () => {
  test('the second command of a shape says nothing, however it is spelled', () => {
    const steer = createFileToolSteer();
    expect(steer("sed -i 's/a/b/' f")).toContain('an in-place stream edit');
    expect(steer('perl -pi -e "s/a/b/" g')).toBeNull();
  });

  test('each shape is tracked on its own', () => {
    const steer = createFileToolSteer();
    expect(steer("sed -i 's/a/b/' f")).not.toBeNull();
    expect(steer("cat > f <<'EOF'\nx\nEOF")).not.toBeNull();
    expect(steer(`python3 -c "open('f','w').write('x')"`)).not.toBeNull();
    expect(steer("sed -i 's/c/d/' g")).toBeNull();
  });

  test('commands that hand-roll nothing never consume a shape', () => {
    const steer = createFileToolSteer();
    expect(steer('npm test')).toBeNull();
    expect(steer('grep -i needle f')).toBeNull();
    expect(steer("sed -i 's/a/b/' f")).not.toBeNull();
  });

  test('two turns are independent', () => {
    const first = createFileToolSteer();
    const second = createFileToolSteer();
    expect(first("sed -i 's/a/b/' f")).not.toBeNull();
    expect(second("sed -i 's/a/b/' f")).not.toBeNull();
  });
});
