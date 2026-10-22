/** The advisor's decision half, as pure parts: each suppression rule alone, the advice it may give, its system prompt,
 *  and the steps as its model reads them. Where a note then goes is the session advisor's, in unit-session-advisor. */

import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import { describe, test, expect } from 'bun:test';
import type { ModelMessage } from 'ai';
import { createMemoryVfs } from '@kinu.run/test-utils';
import { stepContextLimit } from '../src/context-window';
import { CHARS_PER_TOKEN } from '../src/token-estimate';
import { advisorWorkspaceGuidance } from '../src/prompting/agents-md';
import type { AdvisorWorkspace } from '../src/prompting/agents-md';
import { adviseNote, advisorSystemPrompt, renderForAdvisor } from '../src/advisor/session-advisor';
import type { JsonObject } from '../src/utils/json';
import {
  ADVISOR_NOTE_MAX_CHARS, ADVISOR_SEVERITIES,
  isAdvisorSeverity, isContentFree, isDuplicateNote, judgeNote, normalizeNote,
  type AdvisorNote,
} from '../src/index';

const NOTE: AdvisorNote = {
  note: 'the rotate command exited 1 and the reply says it worked',
  severity: 'concern',
  class: 'wrong-work',
};

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

    // The advisor's system prompt, as each review of a turn's steps sends it.
    const prompt = advisorSystemPrompt([], await advisorWorkspaceGuidance(workspace));

    return { prompt, reads };
  }

  test('absence preserves the pre-guidance prompt bytes', async () => {
    const { prompt, reads } = await promptWith();
    expect(reads).toEqual([]);
    expect(prompt).toBe(advisorSystemPrompt([], ''));
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
  });

  test('admission prices UTF-8 bytes, not JavaScript string length', async () => {
    const { prompt, reads } = await promptWith('é'.repeat(budget));
    expect(reads).toEqual([]);
    expect(prompt).toContain('ADVISOR.md');
  });
});

describe('normalizeNote', () => {
  test('collapses case and punctuation, so "Stop." and "Stop!" are one note', () => {
    expect(isDuplicateNote('Stop.', ['stop'])).toBe(true);
    expect(isDuplicateNote('Stop!', ['stop'])).toBe(true);
    expect(isDuplicateNote('  LGTM  ', ['lgtm'])).toBe(true);
    expect(isDuplicateNote('No   issues -- found', ['no issues found'])).toBe(true);
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

});

describe('the duplicate rule', () => {
  test('matches on the normalised text, not the raw text', () => {
    expect(isDuplicateNote('The Rotate Command Failed!', ['the rotate command failed'])).toBe(true);
  });

  test('does not match a different note', () => {
    expect(isDuplicateNote('a different finding', ['the rotate command failed'])).toBe(false);
  });

});

describe('the completion-gate rule', () => {
  test('an open gate holds back a blocker too — one runtime voice per boundary', () => {
    expect(judgeNote({
      note: { note: 'the build is broken', severity: 'blocker', class: 'wrong-work' },
      minSeverity: 'nit', recent: [], gateOpen: true,
    })).toEqual({ disposition: 'changelog', rule: 'gate-open' });
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

describe('the advice the model may give', () => {
  test('every declared severity and class is advice', () => {
    for (const severity of ADVISOR_SEVERITIES) {
      for (const noteClass of ['wrong-work', 'missed-capability', 'dissatisfaction']) {
        expect(adviseNote({ note: 'a real finding', severity, class: noteClass })).toEqual({ note: 'a real finding', severity, class: noteClass });
      }
    }
  });

  test('an empty or blank note is silence, not an empty card', () => {
    expect(adviseNote({ note: '', severity: 'concern', class: 'wrong-work' })).toBeNull();
    expect(adviseNote({ note: '   ', severity: 'concern', class: 'wrong-work' })).toBeNull();
  });

  // An unlabeled class leaves a note whose kind a judge cannot be told.
  const refusedLabels = [
    { name: 'an unknown or absent severity is refused rather than coerced to a default',
      inputs: [{ note: 'x', severity: 'critical', class: 'wrong-work' }, { note: 'x', class: 'wrong-work' }] },
    { name: 'an unknown or absent class is refused, exactly as a severity is',
      inputs: [{ note: 'x', severity: 'nit', class: 'style' }, { note: 'x', severity: 'nit' }] },
  ] as const;

  for (const refused of refusedLabels) {
    test(refused.name, () => {
      for (const input of refused.inputs) expect(adviseNote(input)).toBeNull();
    });
  }

  test('an over-long note is bounded rather than refused', () => {
    const long = 'x'.repeat(ADVISOR_NOTE_MAX_CHARS + 200);
    expect(adviseNote({ note: long, severity: 'nit', class: 'wrong-work' })?.note).toHaveLength(ADVISOR_NOTE_MAX_CHARS);
  });

  test('no other value is a severity', () => {
    for (const other of ['critical', 'NIT', '', null, 2]) expect(isAdvisorSeverity(other)).toBe(false);
  });
});

describe('the user-dissatisfaction class', () => {
  test('a quoted note still obeys the suppression rules', () => {
    const quoted = { note: 'the user asked you to "write better commit messages"', severity: 'concern', class: 'dissatisfaction' } as const;
    expect(judgeNote({ note: quoted, minSeverity: 'concern', recent: [], gateOpen: false }).disposition).toBe('deliver');
    expect(judgeNote({ note: quoted, minSeverity: 'concern', recent: [normalizeNote(quoted.note)], gateOpen: false }).disposition).toBe('drop');
  });
});

describe('the system prompt', () => {
  test('names the capabilities the agent can reach, so a missed one can be named, and says when none are recorded', () => {
    expect(advisorSystemPrompt(['shell', 'agents'], '')).toContain('shell, agents');
    expect(advisorSystemPrompt([], '')).not.toContain('shell');
  });
});

describe('what the advisor reads of a step', () => {
  const call = (input: JsonObject): ModelMessage => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'shell', input }] });

  const result = (value: string): ModelMessage => ({
    role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'shell', output: { type: 'text', value } }],
  });

  test('a call and its result, by tool, with a step still running marked so', () => {
    const read = [renderForAdvisor(call({ command: 'kinu rotate' }), true), renderForAdvisor(result('exit 1'), false)].join('\n');

    expect(read).toContain('shell');
    expect(read).toContain('kinu rotate');
    expect(read).toContain('exit 1');
    expect(renderForAdvisor(call({}), true)).toStartWith('[in progress] ');
    expect(renderForAdvisor(call({}), false)).not.toStartWith('[in progress] ');
  });

  test('a message with nothing done or said in it is not read at all', () => {
    expect(renderForAdvisor({ role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }] }, true)).toBeNull();
  });
});

// The advisor's route may be another vendor's, so credential-shaped values are redacted before its model reads them.
// Fixtures are assembled at runtime: a contiguous real-shaped literal trips `scripts/secret-scan.ts` and push protection.
describe('advisor secret obfuscation', () => {
  const bearer = 'Bearer ' + 't'.repeat(40);
  const awsKey = 'AK' + 'IA' + '1'.repeat(16);
  const kinuToken = 'pt' + 'a_' + 'ab12cd34';
  const providerKey = 'sk' + '-ant-' + 'x'.repeat(24);
  const privateKey = '-----BE' + 'GIN RSA PRIVATE KEY-----\nMIIB fake body\n-----END RSA PRIVATE KEY-----';

  const steps = (input: JsonObject, value: string): string => [
    renderForAdvisor({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'shell', input }] }, true),
    renderForAdvisor({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'shell', output: { type: 'text', value } }] }, true),
    renderForAdvisor({ role: 'assistant', content: value }, true),
  ].join('\n');

  test('tool args, results and replies carrying credentials are read redacted, a private key body and all', () => {
    const read = steps({ command: 'deploy', token: bearer, key: providerKey }, `deployed with ${awsKey} as ${kinuToken}\n${privateKey}`);

    for (const secret of [bearer, awsKey, kinuToken, providerKey, 'MIIB fake body']) expect(read).not.toContain(secret);
    expect(read).toContain('<redacted>');
  });

  test('secret-free values pass through verbatim, including lookalikes', () => {
    const commit = 'deadbeef'.repeat(5);
    const read = steps({ command: 'kinu rotate', commit, hint: 'pass a Bearer token along' }, 'exit 1');

    expect(read).toContain('kinu rotate');
    expect(read).toContain(commit);
    expect(read).toContain('Bearer token');
    expect(read).toContain('exit 1');
    expect(read).not.toContain('redacted');
  });
});
