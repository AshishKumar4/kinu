/**
 * What the owner uploads in a chat keeps its own name, in /uploads: the agent's context names it there and the Files tab
 * lists it there. An upload of a name already holding other bytes becomes `name (2).ext`; one of the same bytes is the
 * same file. Reported 2026-10-17: an upload was saved as attachments/<sha256>.md, a name the agent could tell from no
 * other.
 */
import { expect, test } from 'bun:test';
import { gatewayWorkspace, sentTurn, workspaceFiles } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding } from './helpers/platform-gateway';

const PROFILE = '# Ashish\n\nBuilds Kinu.\n';

const NEWER = '# Ashish\n\nBuilds Kinu, and its evals.\n';

const markdown = (text: string): string => `data:text/markdown;base64,${Buffer.from(text).toString('base64')}`;

test('an upload keeps its own name in /uploads: the context names it, the Files tab lists it, another of that name is (2)', async () => {
  // What each turn's request carried, its messages as the model was sent them.
  const asked: string[] = [];

  const gateway = stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);

    if (tools.length > 0) asked.push(JSON.stringify(messages));

    return chatCompletion(run, 'Read it.');
  });

  const workspace = gatewayWorkspace(gateway);

  const upload = async (words: string, text: string): Promise<string> => {
    const id = crypto.randomUUID();
    const before = asked.length;

    await sentTurn(workspace.agent, words, id, { files: [{ filename: 'ashish profile.md', mediaType: 'text/markdown', url: markdown(text) }] });

    return asked.slice(before).join('\n');
  };

  const first = await upload('Here is my profile.', PROFILE);
  const second = await upload('Here is the newer one.', NEWER);
  const again = await upload('The first one again.', PROFILE);

  expect(first).toContain('saved to /uploads/ashish profile.md, inlined below');
  expect(second).toContain('saved to /uploads/ashish profile (2).md, inlined below');
  // The same bytes under the same name are the same file: no third copy.
  expect(again).not.toContain('ashish profile (3).md');

  const listed = await workspace.agent.getExecutorFiles('workspace', '/uploads');
  const names = (listed.entries ?? []).map((entry) => entry.name).sort();

  expect(names).toEqual(['ashish profile (2).md', 'ashish profile.md']);

  // Each holds the bytes it was uploaded with.
  const files = workspaceFiles(workspace.agent);

  const text = async (path: string): Promise<string> => {
    const read = await files.readFile(path);

    return typeof read === 'string' ? read : new TextDecoder().decode(read);
  };

  expect(await text('/uploads/ashish profile.md')).toBe(PROFILE);
  expect(await text('/uploads/ashish profile (2).md')).toBe(NEWER);
});
