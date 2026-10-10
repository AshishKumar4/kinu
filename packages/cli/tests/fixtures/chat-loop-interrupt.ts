/** The classic chat loop over piped stdin, on a client whose turn runs until it is stopped. Each send prints `SENT`. */
import { runChatLoop } from '../../src/chat-loop';
import { fakeClient, TURN } from '../helpers/chat-app-fixture';

let release = (): void => {};

const fake = fakeClient({
  name: 'loop',
  send: async (input) => {
    const text = typeof input === 'string' ? input : input.text;
    console.log(`SENT ${text}`);
    fake.emit({ type: 'turn-start', kind: 'user', text });
    await new Promise<void>((resolve) => { release = resolve; });
    fake.emit({ type: 'turn-end', turn: TURN });

    return TURN;
  },
});

await runChatLoop({
  client: {
    ...fake.client,
    stop: () => {
      release();

      return [];
    },
  },
});
