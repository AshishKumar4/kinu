import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { openPublicSession } from '../tests/evals/public-session';
import { EVAL_MODELS } from '@kinu.run/test-utils';
import { summarizeSteps } from '../packages/core/src/events/step-stats';

const secret = process.env.KINU_EVAL_WEB_IDENTITY;

if (!secret) throw new Error('KINU_EVAL_WEB_IDENTITY is required');

const root = join(import.meta.dirname, '../bench-artifacts/cache-ema/2026-09-13', process.env.CACHE_MEASURE_RUN ?? '');

await mkdir(root, { recursive: true });

const conversations = [
  { id: 'plain', turns: [
    'Use your file tool to write cache-note.txt with the exact text: Tea needs hot water. Then reply DONE.',
    'Read cache-note.txt with your file tool. What does it say? Answer in one sentence.',
    'Use run on the workspace runtime to run pwd. Tell me the directory.',
    'Read cache-note.txt again with your file tool. Is it a recipe? Answer briefly.',
    'Use run on the workspace runtime to run ls. Tell me whether cache-note.txt exists.',
    'Read cache-note.txt with your file tool and summarize our conversation in two sentences.',
  ] },
  { id: 'hire', turns: [
    'Use your file tool to write delegate-note.txt with the exact text: Tea needs hot water. Reply DONE.',
    'Hire one subordinate named tea-reader to read delegate-note.txt and report its exact contents. Send it a message asking it to keep its answer to one sentence. Collect its answer and tell me what it said.',
  ] },
  { id: 'craft', turns: [
    'Use execute_tools and workspace.createTool to save a crafted tool named cache_echo that takes a text argument and returns that same text. Read the available declaration and use its actual signature. Do not invoke the saved tool yet. Reply SAVED after saving it.',
    'Use your saved cache_echo crafted tool through execute_tools with the text CACHE_ECHO_OK. Reply with the returned text.',
  ] },
];

await writeFile(join(root, 'workload.json'), JSON.stringify(conversations, null, 2));

await writeFile(join(root, 'health.json'), await (await fetch('https://kinu.run/api/health')).text());

await Promise.all(conversations.map(async (conversation) => {
  const session = await openPublicSession({
    origin: 'https://kinu.run', identity: { kind: 'secret', secret },
    workspace: `eval-cache-ema-${conversation.id}-${Date.now().toString(36)}`,
    purpose: 'A concise assistant that follows the requested tool actions precisely.',
    genesis: false,
    llm: { name: 'workers-ai', baseURL: 'https://kinu.run/api/user/ai/v1', headers: {}, model: EVAL_MODELS.product },
  });

  console.log(`${conversation.id}: opened ${session.workspace}`);

  try {
    for (const [index, prompt] of conversation.turns.entries()) {
      const result = await session.prompt(prompt);
      await writeFile(join(root, `${conversation.id}-turn-${index + 1}.json`), JSON.stringify(result, null, 2));
      const events = await session.runEvents();
      await writeFile(join(root, `${conversation.id}-events.json`), JSON.stringify(events, null, 2));
      const steps = events.filter((event) => event.type === 'step_finish');

      const table = steps.map((step) => ({ runId: step.runId, step: step.stepIndex, input: step.usage?.input, cacheRead: step.usage?.cacheRead,
        share: step.usage?.input && step.usage.cacheRead !== undefined ? step.usage.cacheRead / step.usage.input : null }));

      await writeFile(join(root, `${conversation.id}-summary.json`), JSON.stringify({ table, stats: summarizeSteps(steps, { windowLimit: 200 }) }, null, 2));
      const claimText = await session.readFile('/context/claim.json');
      await writeFile(join(root, `${conversation.id}-claim-${index + 1}.json`), claimText);
      const claim = v.parse(v.object({ turn: v.object({ turnId: v.string(), consumedRevision: v.number() }) }), JSON.parse(claimText));

      for (let revision = 1; revision <= claim.turn.consumedRevision; revision++) {
        const request = await session.readFile(`/context/requests/${claim.turn.turnId}/${revision}.json`);
        await writeFile(join(root, `${conversation.id}-turn-${index + 1}-request-${revision}.json`), request);
      }

      await writeFile(join(root, `${conversation.id}-activity-${index + 1}.json`), JSON.stringify(await session.activity(), null, 2));
      console.log(`${conversation.id}: turn ${index + 1} settled, ${steps.length} steps`);
    }

    await writeFile(join(root, `${conversation.id}-history.json`), JSON.stringify(await session.history(), null, 2));
  } finally {
    await session.teardown();
    console.log(`${conversation.id}: torn down`);
  }
}));
