/** Transcript miner vs fixture sessions: schema drifts and rewound branches. */
import { mkdirSync, writeFileSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { weakLabel, type JsonObject, type JsonValue } from '@kinu.run/core';
import { scratchDir, gitEnv } from '@kinu.run/test-utils';
import { defaultTranscriptRoot, mineTranscripts, renderMineSkips } from '../src/cc-transcript';
import * as v from 'valibot';

const repoRoot = resolve(__dirname, '../../..');

const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');

let clock = 0;

let uuidSeq = 0;

const nextUuid = (): string => `u${++uuidSeq}`;

interface Line extends JsonObject {}

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

  /** A non-conversational link: part of the chain, not the conversation. */
  system(subtype: string): this {
    this.push({ type: 'system', subtype, content: '' });

    return this;
  }

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
  const dir = scratchDir('cc-corpus');

  return dir;
}

const text = (t: string) => [{ type: 'text', text: t }];

const toolUse = (name: string, input: JsonObject) =>
  ({ type: 'tool_use', name, input, id: `t${++uuidSeq}` });

const toolResult = (content: JsonValue, extra: JsonObject = {}) =>
  ({ type: 'tool_result', content, ...extra });

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
    expect(mined.turns[2].item.followup).toBeNull();
    expect(mined.turns[0].project).toBe('proj-a');
    expect(mined.turns[0].sessionId).toBe('s1');
    expect(mined.skips.brokenChains).toBe(0);
  });

  test('a system entry in the chain does not truncate it', () => {
    // Walking only user/assistant links would snap at the first turn timing.
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
      .toBe('(no text response, 1 tool call)');
  });
});

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
    // The `/loop` echo shouts "CURRENT STATE"; read as a follow-up it would fire the frustration rule.
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

describe('the corpus a caller asks for is the corpus they get', () => {
  test('--projects filters, and the traversal order is stable', () => {
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

    const first = mineTranscripts({ root });
    expect(first.turns).toHaveLength(6);
    expect(mineTranscripts({ root }).turns.map((t) => t.item.outcomeId))
      .toEqual(first.turns.map((t) => t.item.outcomeId));
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

describe('mined artifacts cannot be committed', () => {
  test('git ignores the corpus directory and the dated reports', () => {
    // The only mechanical guarantee that private sessions stay out of the repo. `--no-index` avoids depending
    // on file existence; `gitEnv()` because a hook-exported GIT_DIR would answer for another repository.
    for (const path of [
      '.cc-corpus/CC-CORPUS-2026-08-07.md',
      'CC-CORPUS-2026-08-07.md',
      'packages/core/.cc-corpus/corpus.json',
      'docs/CC-CORPUS-2026-08-07.md',
    ]) {
      const result = Bun.spawnSync({
        cmd: ['git', 'check-ignore', '--no-index', '-q', path],
        cwd: repoRoot,
        env: gitEnv(),
      });

      expect({ path, ignored: result.exitCode === 0 }).toEqual({ path, ignored: true });
    }
  });
});

describe('kinu label mine', () => {
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
    expect(stdout).toContain('kinu label score <agent>');
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
      env: { ...process.env, NO_COLOR: '1', KINU_HOME: newRoot() },
    });

    expect(`${result.stdout.toString()}${result.stderr.toString()}`)
      .toContain('is a cloud agent');
    expect(result.exitCode).not.toBe(0);
  });

  test('score stops before any model call when no rule fired', () => {
    // The budget is never opened on a corpus with nothing to check an answer against.
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
      env: { ...process.env, NO_COLOR: '1', KINU_HOME: home },
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
