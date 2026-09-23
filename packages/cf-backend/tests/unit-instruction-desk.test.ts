/**
 * The owner's instruction desk on the hosted backend, driven through the
 * actor's own RPCs over its real workspace plane. The rule is core's
 * (InstructionApprovalDesk); what this pins is the Durable Object's wiring of
 * it: the skill file the agent can write is the one the owner reads, and an
 * approval binds exactly the bytes the owner was shown.
 */
import { describe, expect, test } from 'bun:test';
import { SKILLS_DIR } from '@kinu.run/core';
import { orchestratorHarness, workspaceFiles } from './helpers/actor-harness';

const SKILL = '---\nname: focused\ndescription: a memory-only skill\nallowed_tools: [memory]\n---\nFocus on memory only.\n';

describe('the instruction desk on a Durable Object', () => {
  test('an approval binds the bytes the owner read, and refuses bytes changed since', async () => {
    const { agent } = orchestratorHarness();
    const vfs = workspaceFiles(agent);
    const path = `${SKILLS_DIR}/focused.md`;
    await vfs.mkdir(SKILLS_DIR, { recursive: true });
    await vfs.writeFile(path, SKILL);

    const reviewed = await agent.readInstructionApproval(path);

    if (reviewed === null) throw new Error('the skill file was not found on the workspace plane');
    await vfs.writeFile(path, `${SKILL}\n# changed after review\n`);

    expect(await agent.approveInstruction(path, reviewed.digest)).toMatchObject({
      ok: false, error: expect.stringContaining('changed'),
    });

    const current = await agent.readInstructionApproval(path);

    if (current === null) throw new Error('the changed skill file left the workspace plane');
    expect(await agent.approveInstruction(path, current.digest)).toMatchObject({ ok: true, path });
    expect((await agent.listInstructionApprovals()).items).toContainEqual(
      expect.objectContaining({ path, kind: 'skill', decision: 'approved' }),
    );
  });
});
