/** What waits on the owner: instruction files to follow, and commands the gate parked. */
import { expect } from 'bun:test';
import { DeferredApprovalStore, SKILLS_DIR } from '@kinu.run/core';
import type { SharedCase } from '../cases';

const SKILL = '---\nname: focused\ndescription: a memory-only skill\nallowed_tools: [memory]\n---\nFocus on memory only.\n';

const PATH = `${SKILLS_DIR}/focused.md`;

export const OWNER_DESK_CASES: readonly SharedCase[] = [
  {
    title: 'an instruction approval binds the bytes the owner read; a revoke keeps the refusal',
    covers: ['readInstructionApproval', 'approveInstruction', 'listInstructionApprovals', 'revokeInstruction'],
    async run({ surface, files }) {
      await files.mkdir(SKILLS_DIR, { recursive: true });
      await files.writeFile(PATH, SKILL);

      const reviewed = await surface.readInstructionApproval(PATH);

      if (reviewed === null) throw new Error('the skill file was not found on the workspace plane');
      expect(reviewed).toMatchObject({ path: PATH, kind: 'skill', decision: 'none', bytes: SKILL.length });

      // Bytes changed after the owner read them: the approval names bytes nobody reviewed.
      await files.writeFile(PATH, `${SKILL}\n# changed after review\n`);
      expect(await surface.approveInstruction(PATH, reviewed.digest)).toMatchObject({
        ok: false, error: expect.stringContaining('changed'),
      });

      await files.writeFile(PATH, SKILL);
      expect(await surface.approveInstruction(PATH, reviewed.digest)).toEqual({ ok: true, path: PATH, digest: reviewed.digest });

      // The CLI also lists the AGENTS.md of the directory it runs in; the skill is the case's own.
      const decisionOf = async (): Promise<string | undefined> =>
        (await surface.listInstructionApprovals()).items.find((row) => row.path === PATH)?.decision;

      expect(await decisionOf()).toBe('approved');
      expect(await surface.revokeInstruction(PATH)).toMatchObject({ ok: true, path: PATH });
      expect(await decisionOf()).toBe('revoked');
      expect(await surface.readInstructionApproval(PATH)).toMatchObject({ decision: 'revoked', digest: reviewed.digest });
    },
  },
  {
    title: 'answering "always" to a parked command runs it and grants exactly the rule it tripped',
    covers: ['listDeferredApprovals', 'decideDeferredApprovals'],
    async run({ surface, sql, actor }) {
      const requestedAt = Date.now();
      new DeferredApprovalStore(sql, actor).create({
        id: 'defer-1', command: 'git push --force origin main', executor: 'workspace', reason: 'rewrites main', requestedAt,
      });

      expect(await surface.listDeferredApprovals()).toEqual([{
        id: 'defer-1', command: 'git push --force origin main', executor: 'workspace', reason: 'rewrites main',
        status: 'queued', requestedAt, decidedAt: null,
      }]);

      // One decision per action, deduplicated; an id nobody parked decides nothing.
      expect(await surface.decideDeferredApprovals(['defer-1', 'defer-1', 'no-such-action'], 'always'))
        .toEqual({ decided: ['defer-1'] });
      expect(await surface.listDeferredApprovals()).toEqual([]);
      expect(await surface.getShellApprovalGrants()).toEqual({
        grants: [{ rule: 'git-force-push', executor: 'workspace' }],
      });
    },
  },
];
