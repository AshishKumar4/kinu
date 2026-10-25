/**
 * What the owner uploads in a chat keeps its own name, in /uploads: the agent's context names it there and the Files tab
 * lists it there. An upload of a name already holding other bytes becomes `name (2).ext`; one of the same bytes is the
 * same file. Reported 2026-10-17: an upload was saved as attachments/<sha256>.md, a name the agent could tell from no
 * other.
 */
import { expect, test } from 'bun:test';
import { gatewayWorkspace, sentTurn, workspaceFiles } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';

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

/**
 * #124 (2026-10-25): a macOS screenshot's name holds a narrow no-break space before its AM, which reads as a space. The
 * agent typed the saved path back as it read it, and every open failed ENOENT while `ls` listed the file.
 */
test('an upload opens by the path its agent was told, typed as it reads', async () => {
  const name = 'Screenshot 2026-10-23 at 10.38.05\u202FAM.txt';
  const bytes = 'x'.repeat(9_000);
  const answers: string[] = [];

  const gateway = stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);
    const answered = messages.filter((message) => message.role === 'tool');

    if (tools.length === 0) return chatCompletion(run, 'Screenshot');

    if (answered.length > 0) {
      answers.push(JSON.stringify(answered));

      return chatCompletion(run, 'Read it.');
    }

    const told = /saved to (\/uploads\/[^(]+) \(/u.exec(JSON.stringify(messages))?.[1] ?? '';
    // What a model reads as a space it writes as one.
    const typed = told.replace(/\p{Z}/gu, ' ');

    return toolCallCompletion(run, { tool: 'shell', args: { command: `wc -c < "${typed}"` } }, 'call_open');
  });

  const workspace = gatewayWorkspace(gateway);

  await sentTurn(workspace.agent, 'What does this show?', crypto.randomUUID(), {
    files: [{ filename: name, mediaType: 'text/plain', url: `data:text/plain;base64,${Buffer.from(bytes).toString('base64')}` }],
  });

  expect(answers.join('\n')).toContain(String(bytes.length));
});
