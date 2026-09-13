import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { EVAL_MODELS } from '@kinu.run/test-utils';
import { JsonObjectSchema } from '../packages/core/src/utils/json';

const identity = v.parse(v.object({ origin: v.literal('https://kinu.run'), accessToken: v.string() }),
  JSON.parse(await readFile(join(homedir(), '.config/kinu/eval-session/config.json'), 'utf8')));

const root = join(import.meta.dirname, '../bench-artifacts/cache-ema/2026-09-13');

const body = {
  model: EVAL_MODELS.product, stream: false,
  messages: [
    { role: 'system', content: 'You are a concise assistant. The following is reference material.\n' + 'Tea needs hot water. Read files when asked. Use the workspace runtime for pwd and ls.\n'.repeat(200) },
    { role: 'user', content: 'What does tea need? Reply in five words or fewer.' },
  ],
};

await writeFile(join(root, 'affinity-probe-request.json'), JSON.stringify(body, null, 2));

for (const pinned of [false, true]) {
  for (let step = 0; step < 3; step++) {
    const headers = new Headers({ authorization: `Bearer ${identity.accessToken}`, 'content-type': 'application/json' });

    if (pinned) headers.set('x-session-affinity', 'kinu-cache-ema-measure-2026-09-13');
    const response = await fetch(`${identity.origin}/api/user/ai/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await response.text();
    await writeFile(join(root, `affinity-${pinned ? 'pinned' : 'unrouted'}-${step}.json`), text);

    if (!response.ok) throw new Error(`affinity probe refused: ${response.status}`);
    const parsed = v.parse(JsonObjectSchema, JSON.parse(text));
    console.log(JSON.stringify({ pinned, step, usage: parsed.usage }));
  }
}
