/**
 * The transcript miner, against fixture sessions in every shape the real
 * `~/.claude/projects` tree contains — including the two schema drifts that
 * matter (interrupts and tool denials moved from a text marker to a field) and
 * the rewound branch that a naive line-order read would splice back in.
 *
 * Fixtures rather than the owner's real transcripts: the real ones are private,
 * they change under the test, and none of the shapes below can be asserted
 * against them without pinning the owner's own history into the repository.
 * The real corpus is what `proteus label mine` reports; this is what proves the
 * reader is reading it correctly.
 *
 * Also asserts the one thing the corpus's privacy actually rests on: that the
 * report paths are ignored by git.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { weakLabel, type JsonObject, type JsonValue } from '@proteus/core';
import { defaultTranscriptRoot, mineTranscripts, renderMineSkips } from '../src/cc-transcript.js';
import * as v from 'valibot';

const tempDirs: string[] = [];
const repoRoot = resolve(__dirname, '../../..');
const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Fixture builders ─────────────────────────────────────────────

let clock = 0;
let uuidSeq = 0;
const nextUuid = (): string => `u${++uuidSeq}`;

interface Line extends JsonObject {}

/** A session file builder that keeps the parentUuid chain honest, because that
 *  chain is what the reader walks. */
class Session {
  readonly lines: Line[] = [];
  private parent: string | null = null;

  private push(entry: Line): string {
    const uuid = nextUuid();
    this.lines.push({
      uuid,
      parentUuid: this.parent,
      isSidechain: false,
      entrypoint: 'cli',
      version: '2.1.223',
      timestamp: new Date(1_750_000_000_000 + (clock += 60_000)).toISOString(),
      ...entry,
    });
    this.parent = uuid;
    return uuid;
  }

  user(content: JsonValue, extra: Line = {}): this {
    this.push({ type: 'user', message: { role: 'user', content }, ...extra });
    return this;
  }

  assistant(blocks: JsonValue[], extra: Line = {}): this {
    this.push({ type: 'assistant', message: { role: 'assistant', content: blocks }, ...extra });
    return this;
  }

  /** A non-conversational link — turn timings, hook summaries, compaction
   *  boundaries. Part of the chain, and not part of the conversation. */
  system(subtype: string): this {
    this.push({ type: 'system', subtype, content: '' });
    return this;
  }

  /** Fork the chain back to an earlier message, the way a rewind does. */
  rewindTo(uuid: string | null): this {
    this.parent = uuid;
    return this;
  }

  at(index: number): string {
    return v.parse(v.string(), this.lines[index]?.uuid);
  }

  write(root: string, project: string, sessionId: string): void {
    mkdirSync(join(root, project), { recursive: true });
    writeFileSync(
      join(root, project, `${sessionId}.jsonl`),
      `${this.lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );
  }
}

function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-corpus-'));
  tempDirs.push(dir);
  return dir;
}

const text = (t: string) => [{ type: 'text', text: t }];
const toolUse = (name: string, input: JsonObject) =>
  ({ type: 'tool_use', name, input, id: `t${++uuidSeq}` });
const toolResult = (content: JsonValue, extra: JsonObject = {}) =>
  ({ type: 'tool_result', content, ...extra });

// ── Reading the conversation ─────────────────────────────────────

describe('the miner reconstructs turns from the live conversation', () => {
  test('a plain session yields one turn per prompt, chained by follow-up', () => {
    const root = newRoot();
    new Session()
      .user('add a cache to the token store')
      .assistant([{ type: 'text', text: 'Added an LRU.' }])
      .system('turn_duration')
      .user('now wire it into the resolver')
      .assistant(text('Wired.'))
      .user('perfect thanks')
      .assistant(text('Anything else?'))
      .write(root, 'proj-a', 's1');

    const mined = mineTranscripts({ root });
    expect(mined.turns).toHaveLength(3);
    expect(mined.turns[0].item.userMessage).toBe('add a cache to the token store');
    expect(mined.turns[0].item.assistantResponse).toBe('Added an LRU.');
    expect(mined.turns[0].item.followup).toBe('now wire it into the resolver');
    expect(mined.turns[1].item.followup).toBe('perfect thanks');
    // The last turn has no follow-up, and says so rather than inventing one.
    expect(mined.turns[2].item.followup).toBeNull();
    expect(mined.turns[0].project).toBe('proj-a');
    expect(mined.turns[0].sessionId).toBe('s1');
    expect(mined.skips.brokenChains).toBe(0);
  });

  test('a system entry in the chain does not truncate it', () => {
    // Reading only user/assistant links snapped the walk at the first turn
    // timing and returned a single message per session.
    const root = newRoot();
    const s = new Session().user('the first real request').assistant(text('a'));
    s.system('turn_duration');
    s.system('stop_hook_summary');
    s.user('the second real request').assistant(text('b'));
    s.write(root, 'p', 's');

    expect(mineTranscripts({ root }).turns).toHaveLength(2);
  });

  test('a rewound branch is left out of the live path', () => {
    const root = newRoot();
    const s = new Session().user('build the thing').assistant(text('built it wrong'));
    const forkPoint = s.at(0);
    s.user('this abandoned follow-up must not appear').assistant(text('dead branch'));
    s.rewindTo(forkPoint).assistant(text('built it right')).user('ship it');
    s.write(root, 'p', 's');

    const mined = mineTranscripts({ root });
    expect(mined.turns).toHaveLength(1);
    expect(mined.turns[0].item.assistantResponse).toBe('built it right');
    expect(mined.turns[0].item.followup).toBe('ship it');
  });

  test('a turn with no text response says so instead of looking empty', () => {
    const root = newRoot();
    new Session()
      .user('delete the stale worktrees')
      .assistant([toolUse('Bash', { command: 'git worktree prune' })])
      .user('and now the branches')
      .write(root, 'p', 's');

    expect(mineTranscripts({ root }).turns[0].item.assistantResponse)
      .toBe('(no text response — 1 tool call)');
  });
});

// ── Signals, across the versions that record them differently ────

describe('the signals survive schema drift', () => {
  test('an interrupt reads from the field OR the older text marker', () => {
    const root = newRoot();
    new Session()
      .user('write chapter six')
      .assistant(text('starting'))
      .user(text('[Request interrupted by user]'), { interruptedMessageId: 'msg_1' })
      .user('no, chapter seven first')
      .assistant(text('ok'))
      .write(root, 'new-cli', 's');
    new Session()
      .user('write chapter six')
      .assistant(text('starting'))
      .user(text('[Request interrupted by user for tool use]'))
      .user('no, chapter seven first')
      .assistant(text('ok'))
      .write(root, 'old-cli', 's');

    const mined = mineTranscripts({ root });
    expect(mined.turns).toHaveLength(4);
    for (const project of ['new-cli', 'old-cli']) {
      const first = mined.turns.find((t) => t.project === project && t.item.userMessage.includes('six'));
      expect(first?.signals.interrupted).toBe(true);
      // The marker is a signal, not a follow-up.
      expect(first?.item.followup).toBe('no, chapter seven first');
    }
  });

  test('a rejection reads from toolDenialKind OR the older sentence', () => {
    const root = newRoot();
    new Session()
      .user('clean up the caches')
      .assistant([toolUse('Bash', { command: 'rm -rf ~/.cache' })])
      .user([toolResult('The user doesn\'t want to proceed with this tool use. The tool use was rejected.',
        { is_error: true })], { toolDenialKind: 'user-rejected' })
      .user('not that directory')
      .write(root, 'new-cli', 's');
    new Session()
      .user('clean up the caches')
      .assistant([toolUse('Bash', { command: 'rm -rf ~/.cache' })])
      .user([toolResult([{ type: 'text', text: 'The user doesn\'t want to proceed with this tool use.' }],
        { is_error: true })])
      .user('not that directory')
      .write(root, 'old-cli', 's');

    const mined = mineTranscripts({ root });
    expect(mined.turns.filter((t) => t.signals.toolRejected)).toHaveLength(2);
  });

  test('a policy denial is not the user saying no', () => {
    const root = newRoot();
    new Session()
      .user('deploy it')
      .assistant([toolUse('Bash', { command: 'wrangler deploy' })])
      .user([toolResult('Permission for this action was denied by the Claude Code auth policy.',
        { is_error: true })], { toolDenialKind: 'automode-blocked' })
      .user('right, needs the token')
      .write(root, 'p', 's');

    expect(mineTranscripts({ root }).turns[0].signals.toolRejected).toBe(false);
  });

  test('the next turn\'s shell commands ride along for the revert rule', () => {
    const root = newRoot();
    new Session()
      .user('add the migration')
      .assistant(text('added'))
      .user('revert that, it broke the build')
      .assistant([toolUse('Bash', { command: 'git reset --hard HEAD~1' })])
      .write(root, 'p', 's');

    const mined = mineTranscripts({ root });
    expect(mined.turns[0].signals.nextTurnCommands).toEqual(['git reset --hard HEAD~1']);
    expect(weakLabel(mined.turns[0]).rules).toContain('reverted');
  });
});

// ── What is deliberately not the user ────────────────────────────

describe('the miner keeps the owner apart from everything else', () => {
  test('CLI wrappers, slash commands and agent notices are not prompts', () => {
    const root = newRoot();
    new Session()
      .user('research the docs frameworks')
      .assistant(text('researching'))
      .user('<local-command-caveat>Caveat: …</local-command-caveat>', { isMeta: true })
      .user('<command-name>/model</command-name>')
      .user('<local-command-stdout>Set model to Fable 5</local-command-stdout>')
      .user('<command-message>loop</command-message><command-name>/loop</command-name>' +
        '<command-args>Continue autonomous execution of the CURRENT STATE plan</command-args>')
      .user('2 background agents were stopped by the user: "Write ch12", "Integrate ch13".')
      .user('/compact')
      .user('the docs still look wrong')
      .write(root, 'p', 's');

    const mined = mineTranscripts({ root });
    expect(mined.turns).toHaveLength(2);
    expect(mined.turns[0].item.followup).toBe('the docs still look wrong');
    // The `/loop` echo shouts "CURRENT STATE"; read as a follow-up it would
    // have fired the frustration rule on somebody else's words.
    expect(weakLabel(mined.turns[0]).rules).toEqual([]);
  });

  test('sub-agent transcripts and non-interactive prompts are dropped', () => {
    const root = newRoot();
    new Session()
      .user('the owner asks', { entrypoint: 'cli' })
      .assistant(text('answering'))
      .user('a harness asks', { entrypoint: 'sdk-cli' })
      .assistant(text('answering the harness'))
      .user('a sidechain asks', { isSidechain: true })
      .user('the owner again', { entrypoint: 'cli' })
      .write(root, 'p', 's');

    const mined = mineTranscripts({ root });
    expect(mined.turns.map((t) => t.item.userMessage)).toEqual(['the owner asks', 'the owner again']);
    // The harness's work is not attributed to the owner's previous request.
    expect(mined.turns[0].item.followup).toBe('the owner again');
    expect(mined.turns[0].item.assistantResponse).toBe('answering');
    expect(mined.skips.nonInteractivePrompts).toBe(1);
    expect(mined.skips.sidechainEntries).toBe(1);
  });

  test('greetings do not become turns', () => {
    const root = newRoot();
    new Session().user('hey').assistant(text('hi')).user('thanks').write(root, 'p', 's');
    const mined = mineTranscripts({ root });
    expect(mined.turns).toHaveLength(0);
    expect(mined.skips.trivialTurns).toBe(2);
  });
});

// ── Skips are counted, never silent ──────────────────────────────

describe('what the reader could not read is reported', () => {
  test('a malformed line is skipped and counted', () => {
    const root = newRoot();
    const s = new Session().user('a real prompt').assistant(text('a real answer'));
    s.write(root, 'p', 's');
    writeFileSync(
      join(root, 'p', 's.jsonl'),
      `${s.lines.map((l) => JSON.stringify(l)).join('\n')}\n{not json\n"a bare string"\n`,
      'utf8',
    );

    const mined = mineTranscripts({ root });
    expect(mined.turns).toHaveLength(1);
    expect(mined.skips.unparsableLines).toBe(2);
  });

  test('an unknown user content shape is counted, not guessed at', () => {
    const root = newRoot();
    new Session()
      .user('a real prompt')
      .assistant(text('an answer'))
      .user(42)
      .user('another prompt')
      .write(root, 'p', 's');

    const mined = mineTranscripts({ root });
    expect(mined.skips.unknownContent).toBe(1);
    expect(mined.turns[0].item.followup).toBe('another prompt');
  });

  test('the provenance block names every count a reader would ask about', () => {
    const root = newRoot();
    new Session().user('a prompt').assistant(text('an answer')).write(root, 'p', 's');
    const rendered = renderMineSkips(mineTranscripts({ root })).join('\n');
    expect(rendered).toContain('session files');
    expect(rendered).toContain('CLI versions: 2.1.223');
    expect(rendered).toContain('unparsable lines');
    expect(rendered).toContain('broken parent chains');
  });
});

// ── Selection and determinism ────────────────────────────────────

describe('the corpus a caller asks for is the corpus they get', () => {
  test('--projects filters, --limit takes a stable prefix', () => {
    const root = newRoot();
    for (const project of ['alpha', 'beta']) {
      new Session()
        .user(`${project} — the first request`).assistant(text('a'))
        .user(`${project} — the second request`).assistant(text('b'))
        .user(`${project} — the third request`).assistant(text('c'))
        .write(root, project, 's');
    }

    expect(mineTranscripts({ root, projects: ['alpha'] }).turns.map((t) => t.project))
      .toEqual(['alpha', 'alpha', 'alpha']);

    const first = mineTranscripts({ root, limit: 4 });
    expect(first.turns).toHaveLength(4);
    expect(mineTranscripts({ root, limit: 4 }).turns.map((t) => t.item.outcomeId))
      .toEqual(first.turns.map((t) => t.item.outcomeId));
    expect(first.turns.map((t) => t.item.outcomeId))
      .toEqual(mineTranscripts({ root }).turns.slice(0, 4).map((t) => t.item.outcomeId));
  });

  test('a missing transcript root is empty, not an error', () => {
    const mined = mineTranscripts({ root: join(newRoot(), 'nothing-here') });
    expect(mined.turns).toHaveLength(0);
    expect(mined.files).toBe(0);
  });

  test('the default root is where Claude Code keeps them', () => {
    expect(defaultTranscriptRoot('/home/someone')).toBe('/home/someone/.claude/projects');
  });
});

// ── Privacy ──────────────────────────────────────────────────────

describe('mined artifacts cannot be committed', () => {
  test('git ignores the corpus directory and the dated reports', () => {
    // The only mechanical guarantee that the owner's private sessions stay out
    // of the repository. `--no-index` so the answer does not depend on whether
    // a file happens to exist right now.
    for (const path of [
      '.cc-corpus/CC-CORPUS-2026-08-07.md',
      'CC-CORPUS-2026-08-07.md',
      'packages/core/.cc-corpus/corpus.json',
      'docs/CC-CORPUS-2026-08-07.md',
    ]) {
      const result = Bun.spawnSync({
        cmd: ['git', 'check-ignore', '--no-index', '-q', path],
        cwd: repoRoot,
      });
      expect({ path, ignored: result.exitCode === 0 }).toEqual({ path, ignored: true });
    }
  });
});

// ── The command the owner types ──────────────────────────────────

describe('proteus label mine', () => {
  test('reports the corpus and its caveats, without a model', () => {
    const root = newRoot();
    new Session()
      .user('add a cache to the token store')
      .assistant(text('done'))
      .user(text('[Request interrupted by user]'), { interruptedMessageId: 'msg_1' })
      .user('no, put it in the resolver')
      .assistant(text('moved it'))
      .user('perfect thanks')
      .write(root, 'proj-a', 's1');

    const out = join(newRoot(), 'report', 'CC-CORPUS-test.md');
    const result = Bun.spawnSync({
      cmd: [process.execPath, cliBin, 'label', 'mine', '--root', root, '--out', out],
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const stdout = `${result.stdout.toString()}${result.stderr.toString()}`;

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Selection bias');
    expect(stdout).toContain('| interrupted | corrected | 1 | 1 |');
    expect(stdout).toContain('| approved | accepted | 1 | 1 |');
    expect(stdout).toContain('2 labeled');
    expect(stdout).toContain('proteus label score <agent>');
    expect(Bun.file(out).size).toBeGreaterThan(0);
  });

  test('--json prints the numbers and no report file', () => {
    const root = newRoot();
    new Session()
      .user('a prompt with substance in it')
      .assistant(text('an answer'))
      .user('Wait, that is wrong')
      .write(root, 'p', 's');

    const result = Bun.spawnSync({
      cmd: [process.execPath, cliBin, 'label', 'mine', '--root', root, '--json'],
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const parsed = v.parse(v.object({
      stats: v.object({
        turns: v.number(), labeled: v.number(),
        byRule: v.array(v.object({ rule: v.string(), fired: v.number() })),
      }),
      classifier: v.null(),
      cost: v.array(v.object({})),
    }), JSON.parse(result.stdout.toString()));

    expect(result.exitCode).toBe(0);
    expect(parsed.stats.turns).toBe(2);
    expect(parsed.stats.labeled).toBe(1);
    expect(parsed.stats.byRule.find((r) => r.rule === 'steering')?.fired).toBe(1);
    expect(parsed.classifier).toBeNull();
    expect(parsed.cost).toEqual([]);
  });

  test('score refuses a cloud agent, because the corpus is on this machine', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, cliBin, 'label', 'score', 'somewhere-else', '--root', newRoot()],
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', PROTEUS_HOME: newRoot() },
    });
    expect(`${result.stdout.toString()}${result.stderr.toString()}`)
      .toContain('is a cloud agent');
    expect(result.exitCode).not.toBe(0);
  });

  test('score stops before any model call when no rule fired', () => {
    // The zero-cost half of the paid command: the budget is never opened on a
    // corpus with nothing to check an answer against.
    const home = newRoot();
    mkdirSync(join(home, 'demo'), { recursive: true });
    writeFileSync(join(home, 'demo', 'agent.db'), '');

    const root = newRoot();
    new Session()
      .user('a prompt with substance in it')
      .assistant(text('an answer'))
      .user('and another unremarkable follow-up here')
      .write(root, 'p', 's');

    const result = Bun.spawnSync({
      cmd: [process.execPath, cliBin, 'label', 'score', 'demo', '--root', root],
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1', PROTEUS_HOME: home },
    });
    expect(`${result.stdout.toString()}${result.stderr.toString()}`)
      .toContain('no rule fired on any mined turn');
    expect(result.exitCode).toBe(0);
  });

  test('says so plainly when nothing fired', () => {
    const root = newRoot();
    new Session()
      .user('a prompt with substance in it')
      .assistant(text('an answer'))
      .user('and another unremarkable follow-up here')
      .write(root, 'p', 's');

    const result = Bun.spawnSync({
      cmd: [process.execPath, cliBin, 'label', 'mine', '--root', root,
        '--out', join(newRoot(), 'r.md')],
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(`${result.stdout.toString()}${result.stderr.toString()}`)
      .toContain('no rule fired on any mined turn');
  });
});
