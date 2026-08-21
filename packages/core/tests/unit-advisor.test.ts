/**
 * The advisor's decision half.
 *
 * Every suppression rule is tested on its own, because the point of putting the
 * guard in code was that each rule is separately checkable. The lane is tested
 * as a whole against a two-line fake reviewer, so what it DOES with a verdict —
 * speak it, record it, or drop it — is pinned to observable calls rather than to
 * a branch count.
 */

import { describe, test, expect } from 'bun:test';
import {
  ADVISOR_DEDUPE_WINDOW, ADVISOR_HEADER, ADVISOR_NOTE_MAX_CHARS,
  ADVISOR_SEVERITIES, ADVISOR_SEVERITY_METADATA_KEY, ADVISOR_SIGNAL_KIND,
  CONTENT_FREE_NOTES, DEFAULT_ADVISOR_MIN_SEVERITY,
  buildAdvisorPrompt, isAdvisorSeverity, isContentFree, isDuplicateNote,
  judgeNote, normalizeNote, parseAdvisorReply, runAdvisorLane,
  type AdvisorNote, type AdvisorSeverity,
} from '../src/index';
import type { AgentSignal } from '../src/types/signals';
import type { CompletedTurn } from '../src/evolution/types';
import type { LLM } from '../src/types/primitives';

const aTurn = (over: Partial<CompletedTurn> = {}): CompletedTurn => ({
  userMessage: 'rotate the staging keys',
  assistantResponse: 'rotated them',
  toolCalls: [{ name: 'run', args: { command: 'kinu rotate' }, result: 'exit 1' }],
  steps: 3,
  durationMs: 900,
  feedback: null,
  hadError: false,
  turnId: 'msg-1',
  ...over,
});

/** A reviewer that answers exactly what a test hands it. */
const saying = (raw: string): LLM => ({
  async *stream() { yield ''; },
  complete: async () => raw,
});

const NOTE: AdvisorNote = {
  note: 'the rotate command exited 1 and the reply says it worked',
  severity: 'concern',
  class: 'wrong-work',
};

/** One lane run, with everything it touched recorded. */
async function lane(over: {
  llm?: LLM | undefined;
  enabled?: boolean;
  minSeverity?: AdvisorSeverity;
  recent?: readonly string[];
  gateOpen?: boolean;
  turn?: CompletedTurn;
} = {}) {
  const delivered: AgentSignal[] = [];
  const recorded: AdvisorNote[] = [];
  const disposition = await runAdvisorLane({
    turn: over.turn ?? aTurn(),
    llm: 'llm' in over ? over.llm : saying(JSON.stringify(NOTE)),
    enabled: over.enabled ?? true,
    minSeverity: over.minSeverity ?? DEFAULT_ADVISOR_MIN_SEVERITY,
    recent: over.recent ?? [],
    gateOpen: over.gateOpen ?? false,
    deliver: async (signal) => { delivered.push(signal); return 'queued'; },
    record: (note) => { recorded.push(note); },
  });
  return { disposition, delivered, recorded };
}

// ── The switch ──────────────────────────────────────────────────────────────

describe('the owner’s switch', () => {
  test('off means no review at all, so no advisor spend exists', async () => {
    let called = 0;
    const counting: LLM = { async *stream() { yield ''; }, complete: async () => { called += 1; return '{}'; } };
    const run = await lane({ enabled: false, llm: counting });
    expect(called).toBe(0);
    expect(run).toMatchObject({ disposition: null, delivered: [], recorded: [] });
  });

  test('the default floor is `concern`, which keeps the conversation quiet', () => {
    expect(DEFAULT_ADVISOR_MIN_SEVERITY).toBe('concern');
  });

  test('a backend that wires no reviewer does nothing, whatever the switch says', async () => {
    const run = await lane({ llm: undefined });
    expect(run).toMatchObject({ disposition: null, delivered: [], recorded: [] });
  });
});

// ── Severity ────────────────────────────────────────────────────────────────

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

// ── Suppression, one rule at a time ─────────────────────────────────────────

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

// ── The model's answer ──────────────────────────────────────────────────────

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

  test('an unknown severity is refused rather than coerced to a default', () => {
    expect(parseAdvisorReply('{"note":"x","severity":"critical","class":"wrong-work"}')).toBeNull();
    expect(parseAdvisorReply('{"note":"x","class":"wrong-work"}')).toBeNull();
  });

  // The class is held to the severity's standard for the same reason: an
  // unlabeled note reaches the eval split as an instance whose kind nobody can
  // name, and a judge cannot be told what it is grading.
  test('an unknown or absent class is refused, exactly as a severity is', () => {
    expect(parseAdvisorReply('{"note":"x","severity":"nit","class":"style"}')).toBeNull();
    expect(parseAdvisorReply('{"note":"x","severity":"nit"}')).toBeNull();
  });

  test('prose around the JSON is tolerated, because models add it', () => {
    expect(parseAdvisorReply(
      'Here you go:\n```json\n{"note":"real finding","severity":"nit","class":"missed-capability"}\n```',
    )).toEqual({ note: 'real finding', severity: 'nit', class: 'missed-capability' });
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
    // The gap this closes. The suppression rules in review.ts stop a note being
    // REPEATED; nothing stopped it being about scope, backwards compatibility or
    // a request for clarification, which is what a turn-end reviewer reaches for
    // when the turn was fine. Ported from oh-my-pi's watchdog prompt
    // (prompts/advisor/system.md), whose emission-guard mechanism this file
    // already cites — the mechanism came over, the negative space did not.
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
    // renderToolCall bounds every argument and result at patternToolCall (800
    // chars). A reviewer that treats a window's tail as absence asserts values
    // the record never showed it.
    expect(prompt).toContain('what a window drops is');
    expect(prompt).toContain('never assert a value the record does not show');
  });

  test('each severity carries a worked note inside the length bound it will be cut to', () => {
    // Severity calibration had one clause per tier and no instance, while note
    // CONTENT had a cap, a dedupe window and a content-free filter. Three
    // examples give the tier the same rigour, and each is a note that would
    // survive parseAdvisorReply's slice unchanged.
    const examples = [...prompt.matchAll(/^ {2}e\.g\. "(.+)"$/gm)].map((match) => match[1]!);
    expect(examples).toHaveLength(ADVISOR_SEVERITIES.length);
    for (const example of examples) expect(example.length).toBeLessThanOrEqual(ADVISOR_NOTE_MAX_CHARS);
    expect(prompt).toContain('could have been one edit');
    expect(prompt).toContain('its text starts `Error (exit 3)`');
    expect(prompt).toContain('Stop and confirm a backup exists before continuing.');
  });
});

describe('the missed-capability class', () => {
  test('lists a reachable capability the turn did not call', () => {
    const prompt = buildAdvisorPrompt(aTurn(), ['run', 'agents', 'file']);
    expect(prompt).toContain('Reachable capabilities it did not use: agents, file');
  });

  test('never lists a capability the turn DID call', () => {
    expect(buildAdvisorPrompt(aTurn(), ['run'])).toContain('did not use: (none recorded)');
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
      complete: async (prompt) => { seen = prompt; return '{}'; },
    };
    await runAdvisorLane({
      turn: aTurn(), llm: capturing, enabled: true, minSeverity: 'concern',
      recent: [], gateOpen: false, reachable: ['agents'],
      deliver: async () => 'queued', record: () => {},
    });
    expect(seen).toContain('did not use: agents');
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
});
