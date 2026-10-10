// 26244c765: the classic chat kept its own queue, and Ctrl+C dropped the words queued behind the turn it stopped,
// where the TUI's input machine gives them back.
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const entry = resolve(import.meta.dir, 'fixtures/chat-loop-interrupt.ts');

test('classic chat: stopping a turn gives back what was queued behind it as one line, to send with Enter', async () => {
  const child = Bun.spawn([process.execPath, entry], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } });
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  let seen = '';

  const until = async (text: string): Promise<void> => {
    while (!seen.includes(text)) {
      const { value, done } = await reader.read();

      if (done) throw new Error(`the chat ended before "${text}"; it printed:\n${seen}`);
      seen += decoder.decode(value);
    }
  };

  await child.stdin.write('first\n');
  await until('SENT first');
  await child.stdin.write('/queue later words\n');
  await until('(1 waiting)');
  await child.stdin.write('/queue and more\n');
  await until('(2 waiting)');
  child.kill('SIGINT');
  await until('Interrupting');
  // Given back as one line: nothing is sent until Enter.
  expect(seen).not.toContain('SENT later');
  await child.stdin.write('\n');
  await child.stdin.end();
  await until('SENT later words and more');
  child.kill('SIGKILL');
  await child.exited;

  expect(seen).toContain('SENT later words and more');
});
