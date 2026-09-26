/**
 * What the product-flows rows ask, and the calls the scripted model answers them with. Pure, so the local server and
 * the deployed tiers' Worker (`scripted-model-worker.ts`) both serve it.
 */
import { SLATES_ROOT, workspacePath } from '../packages/core/src/vfs/workspace-path';
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

/** A file name no scaffold file can carry. */
export const FLOW_PROBE = 'flow-probe.txt';

/** The written-file row's one turn. */
export const WRITE_FILE_ASK = `Use your file tool to write a new file named ${FLOW_PROBE} in the workspace, `
  + 'containing exactly the words browser flow probe. Then reply with one line: DONE.';

/** The slate the slate row asks for: its manifest title, its directory, and
 *  words its page serves that no scaffold carries. */
export const FLOW_SLATE = { title: 'Flow probe', id: 'flow', page: 'browser flow slate' } as const;

/** The slate row's one turn. */
export const SLATE_ASK = `Use the file tool to create a slate at ${SLATES_ROOT}/${FLOW_SLATE.id}/. `
  + `Write package.json with main "server.ts" and slate {"title":"${FLOW_SLATE.title}","port":8788,"bindings":{}}. `
  + `Write server.ts so the slate answers GET / with an HTML page whose body is <h1>${FLOW_SLATE.page}</h1>. `
  + 'Start its preview. Reply with the preview URL.';

/** The slate turn's calls, in the order the scripted model plays them: the two files the ask names, then its preview. */
const FLOW_SLATE_CALLS: readonly ScriptedAnswer[] = [
  {
    text: 'Writing the slate.',
    toolCall: { name: 'file', arguments: { action: 'write', path: `${SLATES_ROOT}/${FLOW_SLATE.id}/package.json`, content: JSON.stringify({
      name: FLOW_SLATE.id, main: 'server.ts', slate: { title: FLOW_SLATE.title, port: 8788, bindings: {} },
    }, null, 2) } },
  },
  {
    toolCall: { name: 'file', arguments: { action: 'write', path: `${SLATES_ROOT}/${FLOW_SLATE.id}/server.ts`, content: [
      'import { SlateObject } from "kinu:slate";',
      '',
      'export class Slate extends SlateObject {',
      '  async fetch() {',
      `    return new Response("<h1>${FLOW_SLATE.page}</h1>", { headers: { "content-type": "text/html" } });`,
      '  }',
      '}',
      '',
    ].join('\n') } },
  },
  {
    text: 'Starting its preview.',
    toolCall: { name: 'eval', arguments: { code: `return await workspace.slates.${FLOW_SLATE.id}.$preview();` } },
  },
];

/**
 * The flows' own calls, so the rows test the product and not a model's compliance: asked for a slate at /slates/flow/,
 * the real model wrote none, or wrote a React slate the ask did not name, in 2 of 6 runs (2026-09-25). Each ask gets
 * the calls it names, in order; null for every other request (titles, the mission, a one-word reply).
 */
export function flowsScript(request: ScriptedRequest): ScriptedAnswer | null {
  const asked = (ask: string): boolean => request.userTexts.some((text) => text.includes(ask));

  if (asked(WRITE_FILE_ASK) && request.available.includes('file')) {
    return request.called.includes('file')
      ? { text: 'DONE' }
      : { text: 'Writing the file.', toolCall: { name: 'file', arguments: { action: 'write', path: workspacePath(FLOW_PROBE), content: 'browser flow probe' } } };
  }

  if (asked(SLATE_ASK) && request.available.includes('file')) {
    return FLOW_SLATE_CALLS[request.called.length] ?? { text: `The ${FLOW_SLATE.title} slate is running in its tab.` };
  }

  return null;
}
