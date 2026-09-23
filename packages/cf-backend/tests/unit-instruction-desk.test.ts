/**
 * The owner's instruction desk on the hosted backend, driven through the
 * actor's own RPCs over its real workspace plane. The rule is core's
 * (InstructionApprovalDesk); what this pins is the Durable Object's wiring of
 * it: the skill file the agent can write is the one the owner reads and the one
 * `/skills` serves, and an approval binds exactly the bytes the owner was shown.
 */
import { describe, expect, test } from 'bun:test';
import { BUILTIN_SKILL_FILES, skillViewPath, workspaceSkillPath } from '@kinu.run/core';
import { catalogTurn, gatewayWorkspace, orchestratorHarness, workspaceFiles } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

const SKILL = '---\nname: focused\ndescription: a memory-only skill\nallowed_tools: [memory]\n---\nFocus on memory only.\n';

describe('the instruction desk on a Durable Object', () => {
  test('an approval binds the bytes the owner read, and refuses bytes changed since', async () => {
    const { agent } = orchestratorHarness();
    const vfs = workspaceFiles(agent);
    const path = workspaceSkillPath('focused');
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

  test("the agent's own file tool reads the skill it wrote, and a built-in, under /skills", async () => {
    const toolResults: string[] = [];
    const reads = [skillViewPath('focused'), skillViewPath('slates')];

    const gateway = stubAiBinding((run) => {
      const messages = requestOf(run).messages;
      const results = messages.filter((message) => message.role === 'tool');

      toolResults.splice(0, toolResults.length, ...results.map((message) => JSON.stringify(message.content)));

      const next = reads[results.length];

      return next === undefined
        ? chatCompletion(run, 'Read both.')
        : toolCallCompletion(run, { tool: 'file', args: { action: 'read', path: next } }, `read_${results.length}`);
    });

    const workspace = gatewayWorkspace(gateway);

    await workspaceFiles(workspace.agent).writeFile(workspaceSkillPath('focused'), SKILL);
    await catalogTurn(workspace.agent, 'Read the focused skill and the slates skill.');

    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toContain('Focus on memory only.');
    expect(toolResults[1]).toContain(JSON.stringify(BUILTIN_SKILL_FILES.slates.slice(0, 40)).slice(1, -1));
  });
});
