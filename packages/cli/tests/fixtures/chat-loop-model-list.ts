/** The classic chat loop over piped stdin, on a client whose model list refuses. */
import { runChatLoop } from '../../src/chat-loop';
import { fakeClient } from '../helpers/chat-app-fixture';

const { client } = fakeClient({
  name: 'loop',
  listModels: async () => {
    throw new Error('the provider catalog is unreachable');
  },
});

await runChatLoop({ client });
