import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import * as v from 'valibot';
import { DynamicContextLedger, renderDynamicContextBlock, DYNAMIC_CONTEXT_HEADER, fnv1a64,
  type DynamicContext } from '../packages/core/src/prompting/volatile-context';

const legacyHeader = 'Live system state from the Kinu runtime. It is not conversation, and the user did not write it. A later dynamic_context block supersedes every earlier one.';

const workspace = { name: 'workspace', available: true, configured: true, active: true, status: 'active' };

const idle = { name: 'sandbox', available: true, configured: true, active: false, status: 'idle' };

const base: DynamicContext = {
  factsBlock: 'Tea needs hot water.', memoryTail: 'Read the saved note before answering follow-ups.',
  executors: [workspace, idle],
  tasks: { items: [{ id: 'tea', title: 'Read the note and verify the directory', status: 'in_progress', parentId: null }], total: 1 },
};

const states: DynamicContext[] = [
  { ...base, executors: [workspace, { ...idle, active: true, status: 'active' }] },
  { ...base, executors: [workspace, { ...idle, active: true, status: 'active' }], tasks: { items: [], total: 0 } },
];

const ledger = new DynamicContextLedger();

const history: ModelMessage[] = [{ role: 'user', content: 'Read cache-note.txt' }];

ledger.weave(history, base);

const changes = [];

for (const state of states) {
  history.push({ role: 'assistant', content: 'working' });
  const full = renderDynamicContextBlock(state);

  if (full === null) throw new Error('the controlled state has no full render');
  // These sections are unchanged from 31493141c. Rebuild its old header and
  // delimiter exactly; only the ledger emission policy changed in this probe.
  const body = full.slice(full.indexOf('>\n') + 2, -'\n</dynamic_context>'.length).replace(DYNAMIC_CONTEXT_HEADER, legacyHeader);
  const before = `<dynamic_context fingerprint="${fnv1a64(body)}">\n${body}\n</dynamic_context>`;
  const after = v.parse(v.string(), ledger.weave(history, state).at(-1)?.content);
  changes.push({ state, before, after, beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) });
}

const result = { control: '31493141c full-block renderer; fixed two-change file-read conversation, not a live token-count claim', base, changes };

await writeFile(join(import.meta.dirname, '../bench-artifacts/cache-ema/2026-09-13/delta-bytes.json'), JSON.stringify(result, null, 2));

console.log(JSON.stringify(changes.map(({ beforeBytes, afterBytes }) => ({ beforeBytes, afterBytes })), null, 2));
