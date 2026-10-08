import { compactToolCall } from '../src/evolution/tool-call-record';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
/** The advisor's decision half: each suppression rule alone, and the reply
 *  delivery an advisor agent's answer takes, asserted on observable calls. */

import { describe, test, expect } from 'bun:test';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { stepContextLimit } from '../src/context-window';
import { CHARS_PER_TOKEN } from '../src/token-estimate';
import { advisorWorkspaceGuidance, renderInstructionOmission } from '../src/prompting/agents-md';
import type { AdvisorWorkspace } from '../src/prompting/agents-md';
import {
  ADVISOR_DEDUPE_WINDOW, ADVISOR_HEADER, ADVISOR_NOTE_MAX_CHARS,
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_METADATA_KEY, ADVISOR_SIGNAL_KIND,
  CONTENT_FREE_NOTES, DEFAULT_ADVISOR_MIN_SEVERITY,
  buildAdvisorPrompt, isAdvisorSeverity, isContentFree, isDuplicateNote,
  judgeAdvisorReply, judgeNote, normalizeNote, parseAdvisorReply, sayAdvisorNote,
  type AdvisorNote, type AdvisorSeverity,
} from '../src/index';
import type { AgentSignal } from '../src/types/signals';
import type { CompletedTurn } from '../src/evolution/types';

const aTurn = (over: Partial<CompletedTurn> = {}): CompletedTurn => ({
  userMessage: 'rotate the staging keys',
  assistantResponse: 'rotated them',
  toolCalls: [compactToolCall({ name: 'shell', args: { command: 'kinu rotate' }, result: 'exit 1' })],
  steps: 3,
  durationMs: 900,
  feedback: null,
  hadError: false,
  turnId: 'msg-1',
  ...over,
});

const NOTE: AdvisorNote = {
  note: 'the rotate command exited 1 and the reply says it worked',
  severity: 'concern',
  class: 'wrong-work',
};

/** The advisor agent's reply, judged and delivered as the reviewed actor does when it arrives. */
async function lane(over: {
  reply?: string;
  minSeverity?: AdvisorSeverity;
  recent?: readonly string[];
  gateOpen?: boolean;
  turn?: CompletedTurn;
} = {}) {
  const delivered: AgentSignal[] = [];
  const recorded: AdvisorNote[] = [];

  const turnId = (over.turn ?? aTurn()).turnId;

  const judged = judgeAdvisorReply(over.reply ?? JSON.stringify(NOTE), {
    turnId,
    minSeverity: over.minSeverity ?? DEFAULT_ADVISOR_MIN_SEVERITY,
    recent: [...(over.recent ?? [])],
    gateOpen: over.gateOpen ?? false,
    record: (note) => { recorded.push(note); },
  });

  // Said only when judged to be: what every reviewed actor does with the verdict.
  if (judged?.disposition === 'deliver') {
    await sayAdvisorNote(judged.note, {
      turnId,
      send: async (signal) => {
        delivered.push(signal);

        return 'queued';
      },
    });
  }

  const disposition = judged === null ? null : judged.disposition;

  return { disposition, delivered, recorded };
}

describe('workspace advisor guidance', () => {
  const limits = { contextWindow: 800, modelOutputLimit: 400 };
  const budget = stepContextLimit(limits) * CHARS_PER_TOKEN;

  async function promptWith(content?: string) {
    const { vfs } = createMemoryVfs();

    if (content !== undefined) await writeText(vfs, 'ADVISOR.md', content);
    const reads: string[] = [];

    const workspace: AdvisorWorkspace = {
      vfs: {
        ...vfs,
        stat: async (path) => {
          const stat = await vfs.stat(path);

          return stat === null || content === undefined
            ? stat : { ...stat, size: new TextEncoder().encode(content).length };
        },
        readFile: async (path) => {
          reads.push(path);

          return vfs.readFile(path);
        },
      },
      limits: async () => limits,
    };

    // The advisor's task, as the reviewed actor hires it.
    const prompt = buildAdvisorPrompt(aTurn(), [], await advisorWorkspaceGuidance(workspace));

    return { prompt, reads };
  }

  test('absence preserves the pre-guidance prompt bytes', async () => {
    const { prompt, reads } = await promptWith();
    expect(reads).toEqual([]);
    expect(prompt).toBe(buildAdvisorPrompt(aTurn()));
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

});

describe('severity decides where a note goes', () => {
  test('below the floor it is a Changelog row and never a card', async () => {
    const run = await lane({
      reply: (JSON.stringify({ note: 'the variable name is inconsistent', severity: 'nit', class: 'wrong-work' })),
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
      reply: (JSON.stringify({ note: 'the variable name is inconsistent', severity: 'nit', class: 'wrong-work' })),
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
    const run = await lane({ reply: (JSON.stringify({ note: 'Stop.', severity: 'blocker', class: 'wrong-work' })) });
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
    const run = await lane({ reply: ('{}') });
    expect(run).toMatchObject({ disposition: null, delivered: [], recorded: [] });
  });

  test('an empty or blank note is silence, not an empty card', () => {
    expect(parseAdvisorReply('{"note":"","severity":"concern"}')).toBeNull();
    expect(parseAdvisorReply('{"note":"   ","severity":"concern"}')).toBeNull();
  });

  // An unlabeled class leaves a note whose kind a judge cannot be told.
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
    const succeeded = buildAdvisorPrompt(aTurn({ toolCalls: [compactToolCall({ name: 'shell', args: {}, result, outcome: { success: true } })] }));
    const failed = buildAdvisorPrompt(aTurn({ toolCalls: [compactToolCall({ name: 'shell', args: {}, result, outcome: { success: false, reason: 'denied' } })] }));
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

  test('the task forwards what the backend observed', () => {
    expect(buildAdvisorPrompt(aTurn(), ['agents'])).toContain('did not use: agents');
  });
});

// R6, advisor half: on the production turn all 12 native calls were `eval`,
// 5 running `agents.swarm`; native names alone would have listed `agents` as
// unused and prompted a note to delegate.
describe('a capability reached through codemode counts as used', () => {
  const swarmed = (code: string): CompletedTurn => aTurn({
    toolCalls: [compactToolCall({ name: 'eval', args: { code }, result: 'ok' })],
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

  test('each capability is reached through its own namespace', () => {
    expect(buildAdvisorPrompt(swarmed('await workspace.exec("ls")'), ['shell', 'file'])).toContain('did not use: file');
    expect(buildAdvisorPrompt(swarmed('await file.read("a.md")'), ['shell', 'file'])).toContain('did not use: shell');
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
    const first = await lane({ reply: (JSON.stringify(quoted)) });
    expect(first.disposition).toBe('deliver');

    const again = await lane({
      reply: (JSON.stringify(quoted)),
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

// Both backends deliver through one body; the gate is the caller's (see the completion-gate rule).

describe('judgeAdvisorReply', () => {
  test('an unreadable reply is a turn with no advice', async () => {
    expect(await lane({ reply: 'the reviewer wandered off' })).toMatchObject({ disposition: null, delivered: [], recorded: [] });
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
      toolCalls: [compactToolCall({
        name: 'shell',
        args: { command: 'deploy', token: bearer, key: providerKey },
        result: `deployed with ${awsKey} as ${kinuToken}\n${privateKey}`,
      })],
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
      toolCalls: [compactToolCall({
        name: 'shell',
        args: { command: 'kinu rotate', commit, hint: 'pass a Bearer token along' },
        result: 'exit 1',
      })],
    }));

    expect(prompt).toContain('kinu rotate');
    expect(prompt).toContain(commit);
    expect(prompt).toContain('Bearer token');
    expect(prompt).toContain('exit 1');
    expect(prompt).not.toContain('[redacted');
  });
});
