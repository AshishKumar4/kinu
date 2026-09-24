/**
 * The owner's Drive on the deployed product: a folder made and a file put
 * through `/api/drive` list back, the same bytes read at `/shared` from two
 * workspaces of the one owner, a pasted skill lands under `/skills` and is a
 * skill in the listing and on the mount, and the probe leaves nothing behind.
 * No model task; the routes and the mount are the whole claim.
 *
 * The mount is read through each workspace's FILE surface (the files route,
 * which is the executor's mounted VFS: what the agent's `file` tool and the
 * web file manager read), not its shell. The hosted shell runs over Nimbus's
 * own filesystem and crosses no mount, by the same rule that keeps `/pc` and
 * `/sandbox` out of it: name a runtime for commands, cross a mount for files
 * (docs/EXECUTION-LAYER-SPEC.md). Measured 2026-09-21: `cat /shared/...` in
 * the shell answers ENOENT on a Drive the files route reads whole.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { DriveListingSchema, MarkedSkillSchema } from '@kinu.run/core';
import { firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders, type KinuPublicSession } from '../../evals/src/session';

const SUITE = 'First-run · drive';

const CASE = 'drive' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const NOTE = 'drive first-run: one Drive, every workspace\n';

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', genesis: false,
      purpose: 'Disposable Drive probe over the live tenant store; no model task.',
      async run({ session, plan }) {
        const goals: EvalSubgoal[] = [];
        const headers = webHeaders(plan.identity);
        const stamp = crypto.randomUUID().slice(0, 8);
        const folder = `/eval-drive-${stamp}`;
        const skillName = `eval-skill-${stamp}`;

        const drive = async (path: string, init?: RequestInit): Promise<{ status: number; text: string }> => {
          // The identity's headers, then whatever the call adds. Built through
          // `Headers` because `HeadersInit` is also a list of pairs, which a
          // spread would turn into numbered keys.
          const sent = new Headers(headers);

          for (const [name, value] of new Headers(init?.headers)) sent.set(name, value);
          const response = await fetch(`${plan.origin}/api/drive${path}`, { ...init, headers: sent });

          return { status: response.status, text: await response.text() };
        };

        const listing = async (path: string) => {
          const answer = await drive(`?path=${encodeURIComponent(path)}`);

          if (answer.status !== 200) throw new Error(`GET /api/drive?path=${path} answered ${String(answer.status)}: ${answer.text.slice(0, 200)}`);

          return v.parse(DriveListingSchema, JSON.parse(answer.text));
        };

        const root = await listing('/');

        goals.push({
          what: 'drive-routes-answer-with-the-reserved-folders',
          reached: root.entries.some((entry) => entry.name === 'skills' && entry.kind === 'folder'),
          detail: JSON.stringify(root.entries.map((entry) => [entry.name, entry.kind])),
        });

        let second: KinuPublicSession | null = null;

        try {
          const made = await drive('/folders', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder }),
          });

          if (made.status !== 200) throw new Error(`POST /api/drive/folders answered ${String(made.status)}: ${made.text.slice(0, 200)}`);

          const put = await drive(`/files?path=${encodeURIComponent(`${folder}/note.txt`)}`, {
            method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: NOTE,
          });

          if (put.status !== 200) throw new Error(`PUT /api/drive/files answered ${String(put.status)}: ${put.text.slice(0, 200)}`);

          const inFolder = await listing(folder);
          const note = inFolder.entries.find((entry) => entry.name === 'note.txt');

          goals.push({
            what: 'a-put-file-lists-back-with-its-size',
            reached: note?.kind === 'file' && note.size === new TextEncoder().encode(NOTE).byteLength,
            detail: JSON.stringify(inFolder.entries),
          });

          const fetched = await drive(`/files?path=${encodeURIComponent(`${folder}/note.txt`)}`);

          goals.push({
            what: 'a-put-file-downloads-as-the-same-bytes',
            reached: fetched.status === 200 && fetched.text === NOTE,
            detail: JSON.stringify({ status: fetched.status, text: fetched.text.slice(0, 80) }),
          });

          const first = await session.readFile(`/shared${folder}/note.txt`, { allowMissing: true });

          second = await plan.open({ subject: 'drive2', purpose: 'The same owner, a second workspace, the same Drive; no model task.', genesis: false });
          const other = await second.readFile(`/shared${folder}/note.txt`, { allowMissing: true });

          goals.push({
            what: 'the-shared-mount-reads-the-drive-from-two-workspaces',
            reached: first === NOTE && other === NOTE,
            detail: JSON.stringify({ first: first.slice(0, 80), other: other.slice(0, 80) }),
          });

          const added = await drive('/skills', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ skill: `---\nname: ${skillName}\ndescription: A first-run probe skill\n---\n# ${skillName}\n\nSay hello.\n` }),
          });

          if (added.status !== 200) throw new Error(`POST /api/drive/skills answered ${String(added.status)}: ${added.text.slice(0, 200)}`);

          const marked = v.parse(MarkedSkillSchema, JSON.parse(added.text));
          const skills = await listing('/skills');
          const skill = skills.entries.find((entry) => entry.name === skillName);
          const mounted = await session.readFile(`/shared/skills/${skillName}/SKILL.md`, { allowMissing: true });

          goals.push({
            what: 'a-pasted-skill-lands-under-skills-and-is-a-skill-on-the-mount',
            reached: marked.linked === `/skills/${skillName}` && skill?.skill === true
              && mounted.includes(`name: ${skillName}`),
            detail: JSON.stringify({ marked, skill, mounted: mounted.slice(0, 120) }),
          });
        } finally {
          const gone = await drive(`?path=${encodeURIComponent(folder)}`, { method: 'DELETE' });
          const skillGone = await drive(`?path=${encodeURIComponent(`/skills/${skillName}`)}`, { method: 'DELETE' });
          const after = await listing('/');

          goals.push({
            what: 'the-probe-leaves-nothing-behind',
            reached: gone.status === 200 && skillGone.status === 200
              && !after.entries.some((entry) => entry.name === folder.slice(1)),
            detail: JSON.stringify({ gone: gone.status, skillGone: skillGone.status, root: after.entries.map((entry) => entry.name) }),
          });

          if (second !== null) await second.teardown();
        }

        return goals;
      },
    }, observations);
  });
});
