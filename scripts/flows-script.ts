/**
 * What the product-flows rows ask, and the calls the scripted model answers them with. Pure, so the local server and
 * the deployed tiers' Worker (`scripted-model-worker.ts`) both serve it.
 */
import { SLATES_ROOT, workspacePath, WORKSPACE_ROOT } from '../packages/core/src/vfs/workspace-path';
import type { ScriptedAnswer, ScriptedRequest } from './scripted-protocol';

/** A file name no scaffold file can carry. */
export const FLOW_PROBE = 'flow-probe.txt';

/** The file the same turn's shell writes, so Changes is shown a write no file tool made. */
export const FLOW_SHELL_PROBE = 'flow-shell-probe.txt';

/** The storm row's asks: one file that raises the Changes tab, then a burst of files from one shell command. */
export const STORM_SEED_ASK = 'Flow storm: write the seed file.';

export const STORM_ASK = 'Flow storm: write the burst.';

/** The burst's size, and the folder it lands in. */
export const STORM_FILES = 50;

export const STORM_DIR = 'storm';

/** The written-file row's one turn. */
export const WRITE_FILE_ASK = `Use your file tool to write a new file named ${FLOW_PROBE} in the workspace, `
  + 'containing exactly the words browser flow probe. Then reply with one line: DONE.';

/** The slate the slate row asks for: its manifest title, its directory, and
 *  words its page serves that no scaffold carries. */
export const FLOW_SLATE = { title: 'Flow probe', id: 'flow', page: 'browser flow slate' } as const;

/** The slate row's one turn. */
export const SLATE_ASK = `Use the file tool to create a slate at ${SLATES_ROOT}/${FLOW_SLATE.id}/. `
  + `Write package.json with main "server.ts", browser "client.tsx" and slate {"title":"${FLOW_SLATE.title}","port":8788,"bindings":{}}. `
  + 'Write server.ts with a Slate whose bump(by) method adds to a count and returns it. '
  + `Write client.tsx as a React page headed <h1>${FLOW_SLATE.page}</h1> with a Bump button that calls slate.bump. `
  + 'Start its preview. Reply with the preview URL.';

/** The slate's page: React state, a form action and the host's context, so the vendored React and `kinu:slate` both run. */
const FLOW_SLATE_CLIENT = [
  'import { useActionState, useState } from "react";',
  'import { slate, useHostContext } from "kinu:slate";',
  '',
  'export default function App() {',
  '  const host = useHostContext();',
  '  const [by] = useState(2);',
  '  const [count, bump] = useActionState(async () => slate.bump(by), 0);',
  '',
  '  return (',
  '    <form action={bump}>',
  `      <h1>${FLOW_SLATE.page}</h1>`,
  '      <output data-count>{String(count)}</output>',
  '      <p data-host>{typeof host.origin === "string" ? "hosted" : "no host"}</p>',
  '      <button type="submit">Bump</button>',
  '    </form>',
  '  );',
  '}',
  '',
].join('\n');

/** The slate turn's calls, in the order the scripted model plays them: the two files the ask names, then its preview. */
const FLOW_SLATE_CALLS: readonly ScriptedAnswer[] = [
  {
    text: 'Writing the slate.',
    toolCall: { name: 'file', arguments: { action: 'write', path: `${SLATES_ROOT}/${FLOW_SLATE.id}/package.json`, content: JSON.stringify({
      name: FLOW_SLATE.id, main: 'server.ts', browser: 'client.tsx', slate: { title: FLOW_SLATE.title, port: 8788, bindings: {} },
    }, null, 2) } },
  },
  {
    toolCall: { name: 'file', arguments: { action: 'write', path: `${SLATES_ROOT}/${FLOW_SLATE.id}/server.ts`, content: [
      'import { SlateObject } from "kinu:slate";',
      '',
      'export class Slate extends SlateObject {',
      '  count = 0;',
      '',
      '  async bump(by: number) {',
      '    this.count += by;',
      '',
      '    return this.count;',
      '  }',
      '}',
      '',
    ].join('\n') } },
  },
  { toolCall: { name: 'file', arguments: { action: 'write', path: `${SLATES_ROOT}/${FLOW_SLATE.id}/client.tsx`, content: FLOW_SLATE_CLIENT } } },
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
    if (!request.called.includes('file')) {
      return { text: 'Writing the file.', toolCall: { name: 'file', arguments: { action: 'write', path: workspacePath(FLOW_PROBE, WORKSPACE_ROOT), content: 'browser flow probe' } } };
    }

    return request.called.includes('shell') || !request.available.includes('shell')
      ? { text: 'DONE' }
      : { toolCall: { name: 'shell', arguments: { runtime: 'workspace', command: `echo from the shell > ${workspacePath(FLOW_SHELL_PROBE, WORKSPACE_ROOT)}` } } };
  }

  const latest = request.userTexts.at(-1) ?? '';

  if (latest.includes(STORM_SEED_ASK) || latest.includes(STORM_ASK)) {
    if (request.turn.length > 0) return { text: 'DONE' };

    return latest.includes(STORM_SEED_ASK)
      ? { toolCall: { name: 'file', arguments: { action: 'write', path: workspacePath('storm-seed.txt', WORKSPACE_ROOT), content: 'seed' } } }
      : { toolCall: { name: 'shell', arguments: {
        runtime: 'workspace',
        command: `mkdir -p ${STORM_DIR} && for i in $(seq 1 ${String(STORM_FILES)}); do echo $i > ${STORM_DIR}/f$i.txt; done`,
      } } };
  }

  if (asked(SLATE_ASK) && request.available.includes('file')) {
    return FLOW_SLATE_CALLS[request.called.length] ?? { text: `The ${FLOW_SLATE.title} slate is running in its tab.` };
  }

  return null;
}
