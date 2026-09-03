import { describe, expect, test } from 'bun:test';
import type {
  AdmittedInstructionDecision,
  InstructionSourceRow,
  InstructionSourceView,
  Page,
} from '@kinu.run/core';
import type { LocalSessionControls } from '../src/agent-client';
import { executeSlashCommand } from '../src/slash-commands';
import { fakeClient } from './helpers/chat-app-fixture';

const ROOT: InstructionSourceRow = {
  path: '/repo/AGENTS.md', kind: 'agents_md', bytes: 10, decision: 'none',
};
const LATER: InstructionSourceRow = {
  path: '/repo/skills/later.md', kind: 'skill', bytes: 10, decision: 'none',
};
const LATER_ANCHOR = `skill\u0000${LATER.path}`;
const LATER_TOKEN = Buffer.from(LATER_ANCHOR).toString('base64url');
const LATER_ROW_TOKEN = Buffer.from(LATER.path).toString('base64url');
const REVIEWED = 'a'.repeat(64);

function controls(input: {
  readonly approve: (path: string, digest: string) => Promise<AdmittedInstructionDecision>;
  readonly pages: Array<Page<InstructionSourceRow>>;
  readonly reads: string[];
}): LocalSessionControls {
  return {
    getAlwaysActiveSkills: () => [],
    setAlwaysActiveSkills: () => {},
    getShellApprovalMode: () => 'strict',
    setShellApprovalMode: (mode) => mode,
    setShellApprovalHandler: () => () => {},
    listModelProviders: async () => [],
    listInstructionApprovals: async (request) => {
      if (request?.cursor?.after === LATER_ANCHOR) return input.pages[1]!;
      return input.pages[0]!;
    },
    readInstructionApproval: async (path) => {
      input.reads.push(path);
      return path === LATER.path
        ? {
          path,
          kind: 'skill',
          bytes: 10,
          digest: REVIEWED,
          decision: 'none',
          trust: 'unverified',
          placement: 'reference',
          preview: 'reviewed skill source',
        } satisfies InstructionSourceView
        : null;
    },
    approveInstruction: input.approve,
    revokeInstruction: async () => ({ ok: true, path: LATER.path, digest: '' }),
  };
}

describe('/instructions page actions', () => {
  test('read resolves an index against the cursor page, never the root page', async () => {
    const reads: string[] = [];
    const client = fakeClient({
      name: 'instruction-page',
      localControls: controls({
        reads,
        approve: async () => ({ ok: true, path: LATER.path, digest: REVIEWED }),
        pages: [
          { status: 'more', items: [ROOT], next: { after: LATER_ANCHOR } },
          { status: 'end', items: [LATER] },
        ],
      }),
    }).client;

    const outcome = await executeSlashCommand(client, `/instructions read ${LATER_TOKEN} 1 ${LATER_ROW_TOKEN}`);
    if (outcome.kind !== 'text') throw new Error('expected text');
    expect(outcome.text).toContain(LATER.path);
    expect(reads).toEqual([LATER.path]);
  });

  test('approve carries the reviewed digest and refuses a changed file', async () => {
    const reads: string[] = [];
    let approved: { path: string; digest: string } | undefined;
    const client = fakeClient({
      name: 'instruction-review',
      localControls: controls({
        reads,
        approve: async (path, digest) => {
          approved = { path, digest };
          return { ok: false, error: 'the file changed or could not be read after review; read it again before approving' };
        },
        pages: [
          { status: 'end', items: [ROOT] },
          { status: 'end', items: [LATER] },
        ],
      }),
    }).client;

    const outcome = await executeSlashCommand(
      client,
      `/instructions approve ${LATER_TOKEN} 1 ${LATER_ROW_TOKEN} ${REVIEWED}`,
    );
    if (approved === undefined) throw new Error('approve was not called');
    expect(approved).toEqual({ path: LATER.path, digest: REVIEWED });
    if (outcome.kind !== 'text') throw new Error('expected text');
    expect(outcome.text).toContain('Nothing was approved');
    expect(reads).toEqual([]);
  });

  test('approve refuses an action that carries no reviewed digest', async () => {
    const reads: string[] = [];
    const client = fakeClient({
      name: 'instruction-unseen',
      localControls: controls({
        reads,
        approve: async () => ({ ok: true, path: LATER.path, digest: REVIEWED }),
        pages: [
          { status: 'end', items: [ROOT] },
          { status: 'end', items: [LATER] },
        ],
      }),
    }).client;

    const outcome = await executeSlashCommand(client, `/instructions approve ${LATER_TOKEN} 1 ${LATER_ROW_TOKEN}`);
    if (outcome.kind !== 'text') throw new Error('expected text');
    expect(outcome.text).toContain('needs the digest it prints');
    expect(reads).toEqual([]);
  });

  test('an action refuses a row whose carried identity no longer matches the cursor page', async () => {
    const reads: string[] = [];
    let called = false;
    const client = fakeClient({
      name: 'instruction-row-drift',
      localControls: controls({
        reads,
        approve: async () => {
          called = true;
          return { ok: true, path: LATER.path, digest: REVIEWED };
        },
        pages: [
          { status: 'end', items: [ROOT] },
          { status: 'end', items: [LATER] },
        ],
      }),
    }).client;
    const wrongPath = Buffer.from('/repo/skills/inserted.md').toString('base64url');

    const outcome = await executeSlashCommand(
      client,
      `/instructions approve ${LATER_TOKEN} 1 ${wrongPath} ${REVIEWED}`,
    );
    if (outcome.kind !== 'text') throw new Error('expected text');
    expect(outcome.text).toContain('row changed');
    expect(called).toBe(false);
  });
});
