/** The advisor's decision half: each suppression rule alone, and the lane
 *  against a fake reviewer, asserted on observable calls. */

import { describe, test, expect } from 'bun:test';
import { createTestWorkspace } from './helpers';
import { ADVISOR_LANE_FIBER, startAdvisorLane, type AdvisorLaneStart } from '../src/advisor/review';
import { initEffectTombstoneTable } from '../src/identity/effect-tombstones';
import { createHash } from 'node:crypto';
import { createMemoryVfs, testActorHandle } from '@kinu.run/test-utils';
import { stepContextLimit } from '../src/prompting/step-prune';
import { CHARS_PER_TOKEN } from '../src/llm';
import { advisorWorkspaceGuidance, renderInstructionOmission } from '../src/prompting/agents-md';
import type { AdvisorWorkspace } from '../src/prompting/agents-md';
import { KinuError } from '../src/obs/error';
import { createRecordingLogger, setDiagnosticsSink, type RecordingLogger } from '../src/obs/index';
import {
  ADVISOR_DEDUPE_WINDOW, ADVISOR_HEADER, ADVISOR_NOTE_MAX_CHARS,
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_METADATA_KEY, ADVISOR_SIGNAL_KIND,
  CONTENT_FREE_NOTES, DEFAULT_ADVISOR_MIN_SEVERITY,
  buildAdvisorPrompt, isAdvisorSeverity, isContentFree, isDuplicateNote,
  judgeNote, normalizeNote, parseAdvisorReply, reviewRecordedTurn,
  type AdvisorNote, type AdvisorSeverity,
} from '../src/index';
import type { AgentSignal } from '../src/types/signals';
import type { CompletedTurn } from '../src/evolution/types';
import type { LLM } from '../src/types/primitives';
import type { JsonValue } from '../src/utils/json';

const aTurn = (over: Partial<CompletedTurn> = {}): CompletedTurn => ({
  userMessage: 'rotate the staging keys',
  assistantResponse: 'rotated them',
  toolCalls: [{ name: 'shell', args: { command: 'kinu rotate' }, result: 'exit 1' }],
  steps: 3,
  durationMs: 900,
  feedback: null,
  hadError: false,
  turnId: 'msg-1',
  ...over,
});

const saying = (raw: string): LLM => ({
  async *stream() { yield ''; },
  complete: async () => raw,
});

const NOTE: AdvisorNote = {
  note: 'the rotate command exited 1 and the reply says it worked',
  severity: 'concern',
  class: 'wrong-work',
};

async function lane(over: {
  llm?: LLM | undefined;
  minSeverity?: AdvisorSeverity;
  recent?: readonly string[];
  gateOpen?: boolean;
  turn?: CompletedTurn;
  reachable?: readonly string[];
  guidance?: string;
} = {}) {
  const delivered: AgentSignal[] = [];
  const recorded: AdvisorNote[] = [];

  const disposition = await reviewRecordedTurn({
    snapshot: {
      turn: over.turn ?? aTurn(),
      reachable: [...(over.reachable ?? [])],
      minSeverity: over.minSeverity ?? DEFAULT_ADVISOR_MIN_SEVERITY,
      recent: [...(over.recent ?? [])],
    },
    llm: 'llm' in over ? over.llm : saying(JSON.stringify(NOTE)),
    govern: (llm) => llm,
    gateOpen: over.gateOpen ?? false,
    send: async (signal) => {
      delivered.push(signal);

      return 'queued';
    },
    record: (note) => { recorded.push(note); },
    guidance: over.guidance,
  });

  return { disposition, delivered, recorded };
}

describe('workspace advisor guidance', () => {
  const limits = { contextWindow: 800, modelOutputLimit: 400 };
  const budget = stepContextLimit(limits) * CHARS_PER_TOKEN;

  async function promptWith(content?: string) {
    const { vfs } = createMemoryVfs();

    if (content !== undefined) await vfs.writeFile('ADVISOR.md', content);
    const prompts: string[] = [];
    const reads: string[] = [];

    const workspace: AdvisorWorkspace = {
      vfs: {
        ...vfs,
        stat: async (path) => {
          const stat = await vfs.stat(path);

          return stat === null || content === undefined
            ? stat : { ...stat, size: new TextEncoder().encode(content).length };
        },
        readFile: async (path, options) => {
          reads.push(path);

          return vfs.readFile(path, options);
        },
      },
      limits: async () => limits,
    };

    const guidance = await advisorWorkspaceGuidance(workspace);

    await lane({
      guidance,
      llm: {
        ...saying('{}'),
        complete: async (prompt) => {
          prompts.push(prompt);

          return '{}';
        },
      },
    });
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];

    if (prompt === undefined) throw new Error('Advisor made no review call');

    return { prompt, reads };
  }

  test('absence preserves the pre-guidance prompt bytes', async () => {
    const { prompt, reads } = await promptWith();
    expect(reads).toEqual([]);
    expect(prompt).toBe(buildAdvisorPrompt(aTurn()));
    // Bytes of the prompt before workspace guidance existed.
    expect(new TextEncoder().encode(prompt)).toHaveLength(3424);
    expect(createHash('sha256').update(prompt).digest('hex'))
      .toBe('e2ff4713972fd72cd5914694089a52b97a1fdaf379a4575d46a382e22ec3eb2e');
  });

  test('an admitted file has its own review section, including at the exact byte budget', async () => {
    const guidance = 'Watch the migration backup. '.padEnd(budget, 'x');
    const { prompt, reads } = await promptWith(guidance);
    expect(reads).toEqual(['ADVISOR.md']);
    expect(prompt).toContain('## What this workspace asks its advisor to watch for\n\n' + guidance);
  });

  test('oversized guidance uses the shared omission and is never read or partially admitted', async () => {
    const guidance = 'x'.repeat(budget + 1);
    const { prompt, reads } = await promptWith(guidance);
    expect(reads).toEqual([]);
    expect(prompt).not.toContain(guidance);
    expect(prompt).toContain(renderInstructionOmission([{ path: 'ADVISOR.md', bytes: budget + 1 }], 'ADVISOR.md'));
  });

  test('admission prices UTF-8 bytes, not JavaScript string length', async () => {
    const { prompt, reads } = await promptWith('é'.repeat(budget));
    expect(reads).toEqual([]);
    expect(prompt).toContain(`ADVISOR.md (${budget * 2} bytes)`);
  });
});

describe('the owner’s switch', () => {
  test('the default floor is `concern`, which keeps the conversation quiet', () => {
    expect(DEFAULT_ADVISOR_MIN_SEVERITY).toBe('concern');
  });

  test('a backend that wires no reviewer does nothing, whatever the switch says', async () => {
    const run = await lane({ llm: undefined });
    expect(run).toMatchObject({ disposition: null, delivered: [], recorded: [] });
  });
});

describe('severity decides where a note goes', () => {
  test('below the floor it is a Changelog row and never a card', async () => {
    const run = await lane({
      llm: saying(JSON.stringify({ note: 'the variable name is inconsistent', severity: 'nit', class: 'wrong-work' })),
      minSeverity: 'concern',
    });

    expect(run.disposition).toBe('changelog');
    expect(run.delivered).toEqual([]);
    expect(run.recorded).toHaveLength(1);
  });

  test('at the floor it is spoken, once, as a severity-tagged signal', async () => {
    const run = await lane({ minSeverity: 'concern' });
    expect(run.disposition).toBe('deliver');
    expect(run.delivered).toHaveLength(1);
    expect(run.delivered[0]).toMatchObject({
      kind: ADVISOR_SIGNAL_KIND,
      severity: 'concern',
      metadata: { [ADVISOR_SEVERITY_METADATA_KEY]: 'concern' },
      idempotencyKey: 'advisor:msg-1',
    });
  });

  test('a lowered floor lets a nit through — the floor is the only gate on it', async () => {
    const run = await lane({
      llm: saying(JSON.stringify({ note: 'the variable name is inconsistent', severity: 'nit', class: 'wrong-work' })),
      minSeverity: 'nit',
    });

    expect(run.disposition).toBe('deliver');
  });

  test('a raised floor holds a concern back', async () => {
    expect((await lane({ minSeverity: 'blocker' })).disposition).toBe('changelog');
  });

  test('a delivered note is recorded too, so the next turn can dedupe against it', async () => {
    const run = await lane();
    expect(run.recorded).toEqual([NOTE]);
  });

  test('the words the agent reads say the runtime wrote them, not the user', async () => {
    const [signal] = (await lane()).delivered;
    expect(signal?.text).toStartWith(ADVISOR_HEADER);
    expect(signal?.text).toContain(NOTE.note);
  });
});

describe('normalizeNote', () => {
  test('collapses case and punctuation, so "Stop." and "Stop!" are one note', () => {
    expect(normalizeNote('Stop.')).toBe('stop');
    expect(normalizeNote('Stop!')).toBe('stop');
    expect(normalizeNote('  LGTM  ')).toBe('lgtm');
    expect(normalizeNote('No   issues -- found')).toBe('no issues found');
  });
});

describe('the content-free rule', () => {
  test('drops every phrase in the table', () => {
    for (const phrase of CONTENT_FREE_NOTES) expect(isContentFree(phrase)).toBe(true);
  });

  test('drops the same phrase wearing punctuation', () => {
    expect(isContentFree('Stop.')).toBe(true);
    expect(isContentFree('LGTM!')).toBe(true);
  });

  test('drops a note with no letters at all', () => {
    expect(isContentFree('   ...   ')).toBe(true);
  });

  test('keeps a note that states a fact', () => {
    expect(isContentFree(NOTE.note)).toBe(false);
  });

  test('the table is stored normalised, so it can match what the rule compares', () => {
    for (const phrase of CONTENT_FREE_NOTES) expect(normalizeNote(phrase)).toBe(phrase);
  });

  test('a content-free note is neither said nor stored', async () => {
    const run = await lane({ llm: saying(JSON.stringify({ note: 'Stop.', severity: 'blocker', class: 'wrong-work' })) });
    expect(run).toMatchObject({ disposition: 'drop', delivered: [], recorded: [] });
  });
});

describe('the duplicate rule', () => {
  test('matches on the normalised text, not the raw text', () => {
    expect(isDuplicateNote('The Rotate Command Failed!', ['the rotate command failed'])).toBe(true);
  });

  test('does not match a different note', () => {
    expect(isDuplicateNote('a different finding', ['the rotate command failed'])).toBe(false);
  });

  test('the same note twice in a window produces one delivery', async () => {
    const first = await lane();
    expect(first.disposition).toBe('deliver');
    const second = await lane({ recent: first.recorded.map((n) => normalizeNote(n.note)) });
    expect(second).toMatchObject({ disposition: 'drop', delivered: [], recorded: [] });
  });

  test('the window is bounded, so a concern that comes back later can be said again', () => {
    expect(ADVISOR_DEDUPE_WINDOW).toBeGreaterThan(0);
    expect(Number.isFinite(ADVISOR_DEDUPE_WINDOW)).toBe(true);
  });
});

describe('the completion-gate rule', () => {
  test('an open gate wins: the note is recorded, not spoken', async () => {
    const run = await lane({ gateOpen: true });
    expect(run.disposition).toBe('changelog');
    expect(run.delivered).toEqual([]);
    expect(run.recorded).toEqual([NOTE]);
  });

  test('an open gate holds back a blocker too — one runtime voice per boundary', () => {
    expect(judgeNote({
      note: { note: 'the build is broken', severity: 'blocker', class: 'wrong-work' },
      minSeverity: 'nit', recent: [], gateOpen: true,
    })).toEqual({ disposition: 'changelog', rule: 'gate-open' });
  });

  test('a closed gate changes nothing else', async () => {
    expect((await lane({ gateOpen: false })).disposition).toBe('deliver');
  });
});

describe('rule precedence', () => {
  test('a content-free duplicate is dropped as content-free, so nothing is stored', () => {
    expect(judgeNote({
      note: { note: 'Stop.', severity: 'blocker', class: 'wrong-work' },
      minSeverity: 'nit', recent: ['stop'], gateOpen: true,
    })).toEqual({ disposition: 'drop', rule: 'content-free' });
  });

  test('a duplicate beats an open gate: the row it duplicates is already there', () => {
    expect(judgeNote({
      note: NOTE, minSeverity: 'nit', recent: [normalizeNote(NOTE.note)], gateOpen: true,
    })).toEqual({ disposition: 'drop', rule: 'duplicate' });
  });

  test('an open gate beats the floor, because both answer the Changelog anyway', () => {
    expect(judgeNote({ note: NOTE, minSeverity: 'nit', recent: [], gateOpen: true }).rule).toBe('gate-open');
  });

  test('a note that survives every rule carries no rule at all', () => {
    expect(judgeNote({ note: NOTE, minSeverity: 'concern', recent: [], gateOpen: false }))
      .toEqual({ disposition: 'deliver', rule: null });
  });
});

describe('what the model is allowed to answer', () => {
  test('silence is an empty object, and the expected answer', () => {
    expect(parseAdvisorReply('{}')).toBeNull();
  });

  test('silence reaches nothing: no card, no row', async () => {
    const run = await lane({ llm: saying('{}') });
    expect(run).toMatchObject({ disposition: null, delivered: [], recorded: [] });
  });

  test('an empty or blank note is silence, not an empty card', () => {
    expect(parseAdvisorReply('{"note":"","severity":"concern"}')).toBeNull();
    expect(parseAdvisorReply('{"note":"   ","severity":"concern"}')).toBeNull();
  });

  // An unlabeled class leaves eval-split instances whose kind a judge cannot be told.
  const refusedLabels = [
    { name: 'an unknown severity is refused rather than coerced to a default',
      replies: ['{"note":"x","severity":"critical","class":"wrong-work"}', '{"note":"x","class":"wrong-work"}'] },
    { name: 'an unknown or absent class is refused, exactly as a severity is',
      replies: ['{"note":"x","severity":"nit","class":"style"}', '{"note":"x","severity":"nit"}'] },
  ] as const;

  for (const refused of refusedLabels) {
    test(refused.name, () => {
      for (const reply of refused.replies) expect(parseAdvisorReply(reply)).toBeNull();
    });
  }

  test('prose around the JSON is tolerated, because models add it', () => {
    expect(parseAdvisorReply(
      'Here you go:\n```json\n{"note":"real finding","severity":"nit","class":"missed-capability"}\n```',
    )).toEqual({ note: 'real finding', severity: 'nit', class: 'missed-capability' });
  });

  test('prose with no JSON in it is an unreadable answer, not a throw', () => {
    expect(parseAdvisorReply('the turn looks fine, nothing to add')).toBeNull();
  });

  test('an over-long note is bounded rather than refused', () => {
    const long = 'x'.repeat(ADVISOR_NOTE_MAX_CHARS + 200);
    expect(parseAdvisorReply(JSON.stringify({ note: long, severity: 'nit', class: 'wrong-work' })))
      .toEqual({ note: 'x'.repeat(ADVISOR_NOTE_MAX_CHARS), severity: 'nit', class: 'wrong-work' });
  });

  test('every declared severity parses, and nothing else does', () => {
    for (const severity of ADVISOR_SEVERITIES) expect(isAdvisorSeverity(severity)).toBe(true);

    for (const other of ['critical', 'NIT', '', null, 2]) expect(isAdvisorSeverity(other)).toBe(false);
  });
});

describe('the prompt', () => {
  const prompt = buildAdvisorPrompt(aTurn());

  test('carries the turn’s own record, so the reviewer needs no tools', () => {
    expect(prompt).toContain('rotate the staging keys');
    expect(prompt).toContain('rotated them');
    expect(prompt).toContain('kinu rotate');
    expect(prompt).toContain('exit 1');
  });

  test('names every severity it will accept back', () => {
    for (const severity of ADVISOR_SEVERITIES) expect(prompt).toContain(`"${severity}"`);
  });

  test('states silence as the normal answer', () => {
    expect(prompt).toContain('Silence is the normal answer.');
  });

  test('says the turn errored only when it did', () => {
    expect(prompt).not.toContain('the turn errored');
    expect(buildAdvisorPrompt(aTurn({ hadError: true }))).toContain('the turn errored');
  });

  test('a turn that called no tools says so instead of showing an empty list', () => {
    expect(buildAdvisorPrompt(aTurn({ toolCalls: [] }))).toContain('(none)');
  });

  test('enumerates the classes it must stay silent on, each with the reason it exists', () => {
    // Suppression stops repeats, not notes about scope, compatibility or
    // clarification; this negative space is ported from oh-my-pi's
    // prompts/advisor/system.md.
    expect(prompt).toContain('Stay silent on these, however plainly you notice them:');
    expect(prompt).toContain('is usually what was asked for');
    expect(prompt).toContain('quote the instruction when you do');
    expect(prompt).toContain('Backwards compatibility, unless the user or a standing project rule asked for it');
    expect(prompt).toContain('Deleting the');
    expect(prompt).toContain('Never tell the agent to confirm scope, restate the ask, or check in');
    expect(prompt).toContain('A decision the agent understood and committed to');
    expect(prompt).toContain('a failing test, a type error, a lint message in the record');
  });

  test('the windowed record is named UNKNOWN rather than inferred from', () => {
    // renderToolCall bounds args/results at patternToolCall (800 chars); a
    // truncated tail is not absence.
    expect(prompt).toContain('what a window drops is');
    expect(prompt).toContain('never assert a value the record does not show');
  });

  test('the advisor receives producer outcomes even when returned data is identical', () => {
    const result = { error: 'business data' };
    const succeeded = buildAdvisorPrompt(aTurn({ toolCalls: [{ name: 'shell', args: {}, result, outcome: { success: true } }] }));
    const failed = buildAdvisorPrompt(aTurn({ toolCalls: [{ name: 'shell', args: {}, result, outcome: { success: false, reason: 'denied' } }] }));
    expect(succeeded).toContain('"success":true');
    expect(failed).toContain('"success":false');
    expect(failed).toContain('"reason":"denied"');
    expect(succeeded).toContain('business data');
    expect(failed).toContain('business data');
  });
});

describe('the missed-capability class', () => {
  test('lists a reachable capability the turn did not call', () => {
    const prompt = buildAdvisorPrompt(aTurn(), ['shell', 'agents', 'file']);
    expect(prompt).toContain('Reachable capabilities it did not use: agents, file');
  });

  test('never lists a capability the turn DID call', () => {
    expect(buildAdvisorPrompt(aTurn(), ['shell'])).toContain('did not use: (none recorded)');
  });

  test('says nothing was recorded when the caller could not say', () => {
    expect(buildAdvisorPrompt(aTurn())).toContain('did not use: (none recorded)');
  });

  test('bounds the class to the reachable list, so an absent capability is unnameable', () => {
    const prompt = buildAdvisorPrompt(aTurn(), ['agents']);
    expect(prompt).toContain('Only from the reachable list below');
    expect(prompt).not.toContain('swarm');
  });

  test('the lane forwards what the backend observed', async () => {
    let seen = '';

    const capturing: LLM = {
      async *stream() { yield ''; },
      complete: async (prompt) => {
        seen = prompt;

        return '{}';
      },
    };

    await lane({ llm: capturing, reachable: ['agents'] });
    expect(seen).toContain('did not use: agents');
  });
});

// R6, advisor half: on the production turn all 12 native calls were `eval`,
// 5 running `agents.swarm`; native names alone would have listed `agents` as
// unused and prompted a note to delegate.
describe('a capability reached through codemode counts as used', () => {
  const swarmed = (code: string): CompletedTurn => aTurn({
    toolCalls: [{ name: 'eval', args: { code }, result: 'ok' }],
  });

  test('a codemode agents.swarm is never reported unused', () => {
    const prompt = buildAdvisorPrompt(
      swarmed("await agents.swarm({ preset: 'ideate', branches: 3 })"),
      ['agents', 'memory'],
    );

    expect(prompt).toContain('did not use: memory');
    expect(prompt).not.toContain('did not use: agents');
  });

  test('any member of the namespace counts — the action is not the capability', () => {
    const prompt = buildAdvisorPrompt(swarmed('await agents.list({})'), ['agents']);
    expect(prompt).toContain('did not use: (none recorded)');
  });

  const unreached = [
    { name: 'the control — a sandbox program reaching nothing leaves the list intact',
      program: 'await workspace.list(".")' },
    { name: 'a mention in a comment is not a use', program: '// agents.swarm({}) would work here' },
  ] as const;

  for (const unused of unreached) {
    test(unused.name, () => {
      expect(buildAdvisorPrompt(swarmed(unused.program), ['agents'])).toContain('did not use: agents');
    });
  }

  test('a call spelled by a computed key or inside a markdown fence is a use', () => {
    expect(buildAdvisorPrompt(swarmed('await agents["swarm"]({})'), ['agents'])).toContain('did not use: (none recorded)');
    expect(buildAdvisorPrompt(swarmed('```js\nawait agents.swarm({})\n```'), ['agents'])).toContain('did not use: (none recorded)');
  });

  test('a shared namespace reports both its capabilities reached, never neither', () => {
    // `shell` and `file` both reach `workspace`; over-reporting reach is harmless here.
    const prompt = buildAdvisorPrompt(swarmed('await workspace.exec("ls")'), ['shell', 'file']);
    expect(prompt).toContain('did not use: (none recorded)');
  });
});

describe('the user-dissatisfaction class', () => {
  const prompt = buildAdvisorPrompt(aTurn());

  test('asks for the user’s own words, because a paraphrase loses the ask', () => {
    expect(prompt).toContain('QUOTE the user\'s own words in the note.');
  });

  test('reads the turn’s own request, so no new capture is needed for it', () => {
    expect(buildAdvisorPrompt(aTurn({ userMessage: 'write better commit messages' })))
      .toContain('write better commit messages');
  });

  test('a quoted note still obeys the suppression rules', async () => {
    const quoted = { note: 'the user asked you to "write better commit messages"', severity: 'concern', class: 'dissatisfaction' } as const;
    const first = await lane({ llm: saying(JSON.stringify(quoted)) });
    expect(first.disposition).toBe('deliver');

    const again = await lane({
      llm: saying(JSON.stringify(quoted)),
      recent: [normalizeNote(quoted.note)],
    });

    expect(again.disposition).toBe('drop');
  });
});

describe('a turn with no durable id', () => {
  test('is delivered without an idempotency key rather than with a fabricated one', async () => {
    const run = await lane({ turn: aTurn({ turnId: undefined }) });
    expect(run.disposition).toBe('deliver');
    expect(run.delivered[0]).not.toHaveProperty('idempotencyKey');
  });

  test('an empty-string id is no id, so it is delivered without a key', async () => {
    const run = await lane({ turn: aTurn({ turnId: '' }) });
    expect(run.disposition).toBe('deliver');
    expect(run.delivered[0]).not.toHaveProperty('idempotencyKey');
  });
});

// Both backends review from one snapshot through one body; the turn's own
// labels choose the reviewing client, never the mission active later.

describe('reviewRecordedTurn', () => {
  const snapshot = (over: Partial<CompletedTurn> = {}) => ({
    turn: aTurn(over), reachable: ['shell'], minSeverity: DEFAULT_ADVISOR_MIN_SEVERITY, recent: [],
  });

  test('a labelled turn is reviewed on the governed client; an unlabelled one on the bare client', async () => {
    const governed: string[][] = [];
    const bare = saying(JSON.stringify(NOTE));

    const review = (labels: string[] | undefined) => reviewRecordedTurn({
      snapshot: snapshot(labels === undefined ? {} : { missionLabels: labels }),
      llm: bare,
      govern: (llm, asked) => {
        governed.push([...asked]);

        return llm;
      },
      gateOpen: false,
      send: async () => 'queued',
      record: () => {},
    });

    expect(await review(['audit'])).toBe('deliver');
    expect(await review(undefined)).toBe('deliver');
    expect(await review([])).toBe('deliver');
    expect(governed).toEqual([['audit']]);
  });

  test('the gate travels with the caller: open, the note is recorded and not spoken', async () => {
    const delivered: AgentSignal[] = [];
    const recorded: AdvisorNote[] = [];

    const disposition = await reviewRecordedTurn({
      snapshot: snapshot(),
      llm: saying(JSON.stringify(NOTE)),
      govern: (llm) => llm,
      gateOpen: true,
      send: async (signal) => {
        delivered.push(signal);

        return 'queued';
      },
      record: (note) => { recorded.push(note); },
    });

    expect(disposition).toBe('changelog');
    expect(delivered).toEqual([]);
    expect(recorded).toEqual([NOTE]);
  });

  test('a reviewer that is down is a turn with no advice; a defect in the review propagates', async () => {
    const bug: LLM = { async *stream() { yield ''; }, complete: async () => { throw new KinuError('bad_input', 'prompt rejected'); } };
    await expect(reviewRecordedTurn({
      snapshot: snapshot(), llm: bug, govern: (llm) => llm, gateOpen: false,
      send: async () => 'queued', record: () => {},
    })).rejects.toMatchObject({ code: 'bad_input' });
  });

  test('a reviewer that throws is a turn with no advice, never a failed lane', async () => {
    const throwing: LLM = { async *stream() { yield ''; }, complete: async () => { throw new Error('provider down'); } };
    expect(await reviewRecordedTurn({
      snapshot: snapshot(), llm: throwing, govern: (llm) => llm, gateOpen: false,
      send: async () => 'queued', record: () => {},
    })).toBeNull();
    expect(await reviewRecordedTurn({
      snapshot: snapshot(), llm: undefined, govern: (llm) => llm, gateOpen: false,
      send: async () => 'queued', record: () => {},
    })).toBeNull();
  });

});

// Transient failures retry up to three attempts, each recorded on
// `advisor.review_failed`; a definitive failure is recorded once and thrown.

describe('advisor review retries', () => {
  const snapshot = (over: Partial<CompletedTurn> = {}) => ({
    turn: aTurn(over), reachable: ['shell'], minSeverity: DEFAULT_ADVISOR_MIN_SEVERITY, recent: [],
  });

  const attempts = (rec: RecordingLogger) => rec.emitted
    .filter((line) => line.event === 'advisor.review_failed')
    .map((line) => line.fields);

  test('a reviewer that fails twice transiently then answers is heard, with both failures recorded', async () => {
    let calls = 0;

    const limited: LLM = {
      async *stream() { yield ''; },
      complete: async () => {
        calls++;

        // `toProviderError` maps 429 and 5xx to `unavailable`; retry keys on the code.
        if (calls <= 2) throw new KinuError('unavailable', 'advisor model rate-limited (HTTP 429)');

        return JSON.stringify(NOTE);
      },
    };

    const rec = createRecordingLogger();
    const restore = setDiagnosticsSink(rec);

    try {
      const delivered: AgentSignal[] = [];

      const disposition = await reviewRecordedTurn({
        snapshot: snapshot(), llm: limited, govern: (llm) => llm, gateOpen: false,
        send: async (signal) => {
          delivered.push(signal);

          return 'queued';
        },
        record: () => {},
      });

      expect(disposition).toBe('deliver');
      expect(delivered).toHaveLength(1);
    } finally {
      restore();
    }

    expect(calls).toBe(3);
    expect(attempts(rec)).toEqual([{ attempt: 1 }, { attempt: 2 }]);
  });

  test('a definitive failure is recorded once and thrown, never retried', async () => {
    let calls = 0;

    const refusing: LLM = {
      async *stream() { yield ''; },
      complete: async () => {
        calls++;

        throw new KinuError('denied', 'advisor model credentials rejected');
      },
    };

    const rec = createRecordingLogger();
    const restore = setDiagnosticsSink(rec);

    try {
      await expect(reviewRecordedTurn({
        snapshot: snapshot(), llm: refusing, govern: (llm) => llm, gateOpen: false,
        send: async () => 'queued', record: () => {},
      })).rejects.toMatchObject({ code: 'denied' });
    } finally {
      restore();
    }

    expect(calls).toBe(1);
    // A definitive failure is rethrown after one attempt.
    expect(attempts(rec)).toEqual([{ attempt: 1 }]);
  });

  test('three transient failures leave the turn unreviewed, with all three attempts recorded', async () => {
    let calls = 0;

    const down: LLM = {
      async *stream() { yield ''; },
      complete: async () => {
        calls++;

        throw new KinuError('unavailable', 'advisor model unreachable');
      },
    };

    const rec = createRecordingLogger();
    const restore = setDiagnosticsSink(rec);

    try {
      const delivered: AgentSignal[] = [];
      const recorded: AdvisorNote[] = [];

      const disposition = await reviewRecordedTurn({
        snapshot: snapshot(), llm: down, govern: (llm) => llm, gateOpen: false,
        send: async (signal) => {
          delivered.push(signal);

          return 'queued';
        },
        record: (note) => { recorded.push(note); },
      });

      expect(disposition).toBeNull();
      expect(delivered).toEqual([]);
      expect(recorded).toEqual([]);
    } finally {
      restore();
    }

    expect(calls).toBe(3);
    expect(attempts(rec)).toEqual([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }]);
  });
  test('an unclassified failure is definitive: one attempt, one report, no advice', async () => {

    let calls = 0;

    const burning: LLM = {
      async *stream() { yield ''; },
      complete: async () => {
        calls++;

        // A bare Error has no code, so it is not guessed transient.
        throw new Error('reviewer is on fire');
      },
    };

    const rec = createRecordingLogger();
    const restore = setDiagnosticsSink(rec);

    try {
      const disposition = await reviewRecordedTurn({
        snapshot: snapshot(), llm: burning, govern: (llm) => llm, gateOpen: false,
        send: async () => 'queued', record: () => {},
      });

      expect(disposition).toBeNull();
    } finally {
      restore();
    }

    expect(calls).toBe(1);
    expect(attempts(rec)).toEqual([{ attempt: 1 }]);
  });
});

// The deep lane may use another vendor, so credential-shaped values are
// obfuscated before the advisor prompt. Fixtures are assembled at runtime: a
// contiguous real-shaped literal trips `scripts/secret-scan.ts` and push protection.

describe('advisor prompt secret obfuscation', () => {
  const bearer = 'Bearer ' + 't'.repeat(40);
  const awsKey = 'AK' + 'IA' + '1'.repeat(16);
  const kinuToken = 'pt' + 'a_' + 'ab12cd34';
  const providerKey = 'sk' + '-ant-' + 'x'.repeat(24);
  const privateKey = '-----BE' + 'GIN RSA PRIVATE KEY-----\nMIIB fake body\n-----END RSA PRIVATE KEY-----';

  test('tool args and results carrying credentials reach the prompt obfuscated, by shape class', () => {
    const prompt = buildAdvisorPrompt(aTurn({
      toolCalls: [{
        name: 'shell',
        args: { command: 'deploy', token: bearer, key: providerKey },
        result: `deployed with ${awsKey} as ${kinuToken}\n${privateKey}`,
      }],
    }));

    expect(prompt).not.toContain(bearer);
    expect(prompt).not.toContain(awsKey);
    expect(prompt).not.toContain(kinuToken);
    expect(prompt).not.toContain(providerKey);
    expect(prompt).not.toContain(privateKey);
    expect(prompt).toContain('[redacted bearer]');
    expect(prompt).toContain('[redacted api-key]');
    expect(prompt).toContain('[redacted kinu-token]');
    expect(prompt).toContain('[redacted private-key]');
  });

  test('secret-free values pass through verbatim, including lookalikes', () => {
    const commit = 'deadbeef'.repeat(5);

    const prompt = buildAdvisorPrompt(aTurn({
      toolCalls: [{
        name: 'shell',
        args: { command: 'kinu rotate', commit, hint: 'pass a Bearer token along' },
        result: 'exit 1',
      }],
    }));

    expect(prompt).toContain('kinu rotate');
    expect(prompt).toContain(commit);
    expect(prompt).toContain('Bearer token');
    expect(prompt).toContain('exit 1');
    expect(prompt).not.toContain('[redacted');
  });
});

describe('an advisor lane is started once per turn, from its checkpoint', () => {
  /** Both backends start the lane through this rule. A lane with no checkpoint
   *  must reject, and one with a checkpoint must never be opened beside it. */
  test('a lane with no checkpoint is carried again; a replay after the checkpoint opens no second review', async () => {
    const workspace = createTestWorkspace();
    initEffectTombstoneTable(workspace.execRaw);
    const store = { sql: workspace.sql, actor: testActorHandle(workspace.sql) };
    const carried: string[] = [];
    const stashed: JsonValue[] = [];
    const reviewed: string[] = [];

    const start = (carry: AdvisorLaneStart['carry']): Promise<void> => startAdvisorLane(store, {
      turn: { turnId: 'msg-1' }, snapshot: { turnId: 'msg-1' }, carry,
      review: async () => { reviewed.push('msg-1'); },
    });

    const carrier: AdvisorLaneStart['carry'] = async (name, body) => {
      carried.push(name);
      await body({ stash: (data) => { stashed.push(data); } });
    };

    try {
      // Neither failure left a recoverable lane, so each keeps the row owed.
      await expect(start(async () => { throw new Error('the fiber never started'); })).rejects.toThrow();
      await expect(start(async (_name, body) => {
        await body({ stash: () => { throw new Error('storage is full'); } });
      })).rejects.toThrow();

      await start(carrier);
      await start(carrier);

      expect(carried).toEqual([ADVISOR_LANE_FIBER]);
      expect(stashed).toEqual([{ turnId: 'msg-1' }]);
      expect(reviewed).toEqual(['msg-1']);
    } finally {
      workspace.db.close();
    }
  });
});
