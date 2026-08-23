/**
 * /undo — the files half of the walk-back pair. performUndo drives the REAL
 * shadow-git engine (createHostCheckpoints + real git on this host) through
 * the AgentClient checkpoint surface, exactly as LocalAgentClient wires it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostCheckpoints } from '@kinu.run/cli-backend';
import { DEFAULT_ADVISOR_MIN_SEVERITY } from '@kinu.run/core';
import type { EvolutionConfigView, FileCheckpointEntry } from '@kinu.run/core';
import { commandsForClient, executeSlashCommand, filterCommands, groupCheckpointsByTurn, performUndo } from '../src/slash-commands';
import type { AgentClient, FileCheckpointSurface } from '../src/agent-client';
import { createCliSession } from '../src/session';

function inertCheckpointSurface(): FileCheckpointSurface {
  return {
    list: async () => ({ availability: { available: true }, entries: [] }),
    plan: async () => { throw new Error('not used'); },
    restore: async () => { throw new Error('not used'); },
  };
}

function slashClient(checkpoints: FileCheckpointSurface | null): AgentClient {
  const client: AgentClient = {
    mode: 'local', agentName: 'test', cliSession: createCliSession('test', { noSession: true }),
    consents: null, localControls: null, checkpoints, sessionHistory: null, inlineAttachmentLimitBytes: 1024,
    connect: async () => {}, subscribe: () => () => {},
    send: async () => ({ text: '', toolCalls: [], steps: 0, durationMs: 0, hadError: false }),
    steer: () => false, branch: () => false,
    fork: async () => ({ client, label: 'test' }), stop: () => [], close: async () => {},
    history: async () => [],
    status: async () => ({ name: 'test', purpose: 'test', model: null, reasoningEffort: null }),
    describeTools: async () => ({ builtIn: [], crafted: [] }),
    changelog: async () => ({ entries: [], unseenCount: 0 }),
    revertChangelogEntry: async () => ({ ok: false }), readMemory: async () => '',
    searchNodes: async () => [], listJobs: async () => [], latestTakes: async () => null,
    pickTake: async () => { throw new Error('not used'); },
    getModelSpec: async () => null, setModel: async (spec) => ({ spec }),
    getReasoningEffort: async () => null, setReasoningEffort: async (effort) => ({ effort }),
    listModels: async () => ({ models: [], failures: [] }),
    getEvolutionConfig: async () => { throw new Error('not used'); },
    setEvolutionConfig: async () => { throw new Error('not used'); },
  };
  return client;
}

function realEngineClient(opts: { gitBin?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kinu-undo-'));
  const work = join(root, 'project');
  mkdirSync(work, { recursive: true });
  const engine = createHostCheckpoints({ agent: 'undo-test', base: join(root, 'shadow'), gitBin: opts.gitBin });
  // Composed exactly as LocalAgentClient wires it through the session: one call
  // carries reachability with the entries, so no caller can read an empty list
  // as a statement about the turn.
  const checkpoints: FileCheckpointSurface = {
    list: async (limit, turnId) => {
      const availability = await engine.status();
      if (!availability.available) return { availability, entries: [] };
      return { availability, entries: await engine.list({ limit, turnId }) };
    },
    plan: (dir, id) => engine.plan(dir, id),
    restore: (dir, id) => engine.restore(dir, id),
  };
  return { root, work, engine, client: { checkpoints }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('performUndo', () => {
  test('restores the last turn by default, reporting paths and counts first', async () => {
    const { work, engine, client, cleanup } = realEngineClient();
    try {
      writeFileSync(join(work, 'app.ts'), 'turn zero');
      engine.beginTurn({ turnId: 'turn-1', sessionId: 'default' });
      await engine.ensureCheckpoint(work);
      writeFileSync(join(work, 'app.ts'), 'turn one damage');
      writeFileSync(join(work, 'junk.ts'), 'collateral');

      const result = await performUndo(client);
      expect(result.restored).toBe(true);
      expect(result.text).toContain('1 modified');
      expect(result.text).toContain('1 removed');
      expect(result.text).toContain('~ app.ts');
      expect(result.text).toContain('- junk.ts');
      expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('turn zero');
      expect(existsSync(join(work, 'junk.ts'))).toBe(false);
    } finally { cleanup(); }
  });

  test('/undo n walks back n turns; an out-of-range n lists the turns instead', async () => {
    const { work, engine, client, cleanup } = realEngineClient();
    try {
      for (let i = 0; i < 3; i++) {
        writeFileSync(join(work, 'state.txt'), `before turn ${i}`);
        engine.beginTurn({ turnId: `turn-${i}`, sessionId: 'default' });
        await engine.ensureCheckpoint(work);
      }
      writeFileSync(join(work, 'state.txt'), 'final damage');

      const listing = await performUndo(client, '99');
      expect(listing.restored).toBe(false);
      expect(listing.text).toContain('Usage: /undo [n]');

      const result = await performUndo(client, '3'); // back to before turn-0's mutations
      expect(result.restored).toBe(true);
      expect(readFileSync(join(work, 'state.txt'), 'utf8')).toBe('before turn 0');
    } finally { cleanup(); }
  });

  /**
   * A TURN IS RESTORED WHOLE, OR THE WINDOW IS LYING ABOUT SUCCESS.
   *
   * A turn takes one checkpoint per directory it touched, retention is per
   * directory, and the browse limit is global across them — so a turn that
   * touched three directories can arrive with only some of them inside the
   * window. Acting on that window restored part of the turn and printed
   * "✓ N file(s) restored", which is worse than a wrong message: the operator is
   * told the undo succeeded while a directory stays clobbered.
   *
   * The engine here is real. `browseLimit` is forced to 2 so the newest-first
   * window physically cannot hold all three of the turn's checkpoints, which is
   * the same condition 200 reaches once enough directories are active.
   */
  test('a turn split across directories is restored whole, not just the part in the window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kinu-undo-split-'));
    try {
      const dirs = ['one', 'two', 'three'].map((name) => {
        const dir = join(root, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'f.txt'), 'original');
        return dir;
      });
      const engine = createHostCheckpoints({ agent: 'undo-split', base: join(root, 'shadow') });
      engine.beginTurn({ turnId: 'wide-turn', sessionId: 'default' });
      for (const dir of dirs) expect(await engine.ensureCheckpoint(dir)).toBeTruthy();
      for (const dir of dirs) writeFileSync(join(dir, 'f.txt'), 'clobbered');

      // The browse can only see 2 of the 3; a turn-keyed read sees all 3.
      const browseLimit = 2;
      const checkpoints: FileCheckpointSurface = {
        list: async (limit, turnId) => ({
          availability: await engine.status(),
          entries: await engine.list({ limit: turnId === undefined ? browseLimit : limit, turnId }),
        }),
        plan: (dir, id) => engine.plan(dir, id),
        restore: (dir, id) => engine.restore(dir, id),
      };
      expect(await engine.list({ limit: browseLimit })).toHaveLength(2);

      const result = await performUndo({ checkpoints });
      expect(result.restored).toBe(true);
      // All three, not the two the window held.
      for (const dir of dirs) {
        expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('original');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('"/undo 1" after a restore undoes the restore, as the success hint promises', async () => {
    const { work, engine, client, cleanup } = realEngineClient();
    try {
      writeFileSync(join(work, 'app.ts'), 'turn zero');
      engine.beginTurn({ turnId: 'turn-1', sessionId: 'default' });
      await engine.ensureCheckpoint(work);
      writeFileSync(join(work, 'app.ts'), 'turn one damage');

      // First /undo restores to pre-turn state and advertises its own undo.
      const first = await performUndo(client);
      expect(first.restored).toBe(true);
      expect(first.text).toContain('Undo this with /undo 1.');
      expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('turn zero');

      // The promised follow-up: /undo 1 must land on the pre-restore
      // snapshot ("turn one damage"), not re-apply the pre-turn checkpoint.
      const second = await performUndo(client, '1');
      expect(second.restored).toBe(true);
      expect(readFileSync(join(work, 'app.ts'), 'utf8')).toBe('turn one damage');
    } finally { cleanup(); }
  });

  test('reports honestly when nothing changed since the checkpoint', async () => {
    const { work, engine, client, cleanup } = realEngineClient();
    try {
      writeFileSync(join(work, 'a.txt'), 'stable');
      engine.beginTurn({ turnId: 't', sessionId: 'default' });
      await engine.ensureCheckpoint(work);
      const result = await performUndo(client);
      expect(result.restored).toBe(false);
      expect(result.text).toContain('nothing to restore');
    } finally { cleanup(); }
  });

  test('degrades honestly: no checkpoints yet, no surface, and no git', async () => {
    const { client, cleanup } = realEngineClient();
    try {
      const empty = await performUndo(client);
      expect(empty.restored).toBe(false);
      expect(empty.text).toContain('No file checkpoints yet');
    } finally { cleanup(); }

    const noSurface = await performUndo({ checkpoints: null });
    expect(noSurface.restored).toBe(false);
    expect(noSurface.text).toContain('not available');

    const { client: degraded, cleanup: cleanup2 } = realEngineClient({ gitBin: '/nonexistent/git' });
    try {
      const result = await performUndo(degraded);
      expect(result.restored).toBe(false);
      expect(result.text).toBe('checkpoints unavailable: git not found');
    } finally { cleanup2(); }
  });
});

describe('/undo command surface', () => {
  const entry = (id: string, turnId: string | null, at: number): FileCheckpointEntry =>
    ({ id, dir: '/tmp/p', at, turnId, sessionId: 's', reason: 'pre-mutation' });

  test('groups checkpoints by turn, newest first, keeping multi-dir turns together', () => {
    const groups = groupCheckpointsByTurn([
      { ...entry('c3', 'turn-2', 30) },
      { ...entry('c2b', 'turn-1', 21), dir: '/tmp/other' },
      { ...entry('c2a', 'turn-1', 20) },
      { ...entry('c1', null, 10) },
    ]);
    expect(groups.map((g) => g.map((e) => e.id))).toEqual([['c3'], ['c2b', 'c2a'], ['c1']]);
  });

  test('is offered only when the client has a checkpoint surface', async () => {
    const withSurface = {
      localControls: null,
      consents: null,
      checkpoints: inertCheckpointSurface(),
      sessionHistory: null,
    };
    const without = { localControls: null, consents: null, checkpoints: null, sessionHistory: null };
    expect(commandsForClient(withSurface).some((c) => c.name === '/undo')).toBe(true);
    expect(commandsForClient(without).some((c) => c.name === '/undo')).toBe(false);

    const outcome = await executeSlashCommand(slashClient(null), '/undo 2');
    expect(outcome).toEqual({ kind: 'unknown', command: '/undo' });
  });

  test('recorded conversation controls are local-only and cancellation is discoverable', () => {
    const shared = {
      localControls: null,
      consents: null,
      checkpoints: null,
    };
    const local = commandsForClient({
      ...shared,
      sessionHistory: { list: () => [], resume: async () => {} },
    }).map((command) => command.name);
    const cloud = commandsForClient({ ...shared, sessionHistory: null })
      .map((command) => command.name);

    expect(local).toContain('/resume');
    expect(local).toContain('/sessions');
    expect(cloud).not.toContain('/resume');
    expect(cloud).not.toContain('/sessions');
    expect(cloud).toContain('/cancel');
    expect(cloud).toContain('/settings');
  });

  test('command filtering ranks exact, prefix, then stable fuzzy matches', () => {
    const commands = [
      { name: '/setup', description: 'Configure providers' },
      { name: '/settings', description: 'Open interactive settings' },
      { name: '/status', description: 'Show workspace state' },
    ];
    expect(filterCommands(commands, '/status').map((command) => command.name))
      .toEqual(['/status']);
    expect(filterCommands(commands, '/set').map((command) => command.name))
      .toEqual(['/setup', '/settings']);
    expect(filterCommands(commands, '/sttus').map((command) => command.name))
      .toEqual(['/status']);
  });

  test('parses /undo [n] into the surface-owned outcome', async () => {
    const client = slashClient(inertCheckpointSurface());
    expect(await executeSlashCommand(client, '/undo')).toEqual({ kind: 'undo', ref: undefined });
    expect(await executeSlashCommand(client, '/undo 3')).toEqual({ kind: 'undo', ref: '3' });
  });
});

/**
 * /advisor — the advisor's only control surface. It drives the evolution-config
 * RPC pair, so the stub below behaves like the real store: a partial write
 * lands and the effective config comes back.
 */
describe('/advisor command surface', () => {
  function advisorClient(): AgentClient {
    const config: EvolutionConfigView = {
      reviewModel: null,
      autoPromoteScaffold: false,
      gepaEvalBudget: 0,
      shadowSampleRate: 0,
      scaffoldExploreShare: 0,
      advisorEnabled: false,
      advisorMinSeverity: DEFAULT_ADVISOR_MIN_SEVERITY,
    };
    return {
      ...slashClient(null),
      getEvolutionConfig: async () => config,
      setEvolutionConfig: async (view) => Object.assign(config, view),
    };
  }

  async function advisorText(client: AgentClient, input: string): Promise<string> {
    const outcome = await executeSlashCommand(client, input);
    if (outcome.kind !== 'text') throw new Error(`expected text outcome, got ${outcome.kind}`);
    return outcome.text;
  }

  test('is offered to every client — both backends serve the config RPCs', () => {
    for (const checkpoints of [inertCheckpointSurface(), null]) {
      const commands = commandsForClient({
        localControls: null,
        consents: null,
        checkpoints,
        sessionHistory: null,
      });
      expect(commands.some((command) => command.name === '/advisor')).toBe(true);
    }
  });

  test('reports the state, and the report names the floor and the per-turn cost', async () => {
    expect(await advisorText(advisorClient(), '/advisor')).toBe(
      `Advisor: off. The minimum severity is ${DEFAULT_ADVISOR_MIN_SEVERITY}. /advisor on adds one model call per turn.`,
    );
  });

  test('on, off and severity write through, and each write keeps the other field', async () => {
    const client = advisorClient();
    expect(await advisorText(client, '/advisor on')).toBe(
      `Advisor: on. The minimum severity is ${DEFAULT_ADVISOR_MIN_SEVERITY}. The advisor adds one model call per turn.`,
    );
    expect(await advisorText(client, '/advisor')).toContain('Advisor: on.');

    expect(await advisorText(client, '/advisor severity blocker')).toBe(
      'Advisor: on. The minimum severity is blocker. The advisor adds one model call per turn.',
    );
    expect(await advisorText(client, '/advisor off')).toBe(
      'Advisor: off. The minimum severity is blocker. /advisor on adds one model call per turn.',
    );
    expect(await advisorText(client, '/advisor severity nit')).toContain('Advisor: off.');
  });

  test('an unusable argument answers with the usage line, naming every value', async () => {
    const client = advisorClient();
    for (const input of ['/advisor maybe', '/advisor severity', '/advisor severity urgent', '/advisor on off']) {
      expect(await advisorText(client, input)).toBe('Usage: /advisor on | off | severity <nit | concern | blocker>');
    }
    // Nothing was written by any of them.
    expect(await advisorText(client, '/advisor')).toContain('Advisor: off.');
  });
});
