/** Diagnostic-only source transform. Every label names an original source line;
 * values (commands, credentials, RPC results) never enter the trace. */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { parse, declaredName, memberCalleeName, type SyntaxNode } from './syntax';

const root = new URL('..', import.meta.url).pathname;

const files = [
  'node_modules/@cloudflare/containers/dist/lib/container.js',
  'node_modules/@cloudflare/sandbox/dist/sandbox-CPj2jsbz.js',
  'packages/devbox/src/devbox.ts',
];

const helper = `
async function devboxLifecycleTrace(event, step, run) {
  const id = crypto.randomUUID();
  const at = Date.now();
  console.log(JSON.stringify({event: 'devbox.lifecycle.' + event + '.enter', step, id, at}));
  try { return await run(); }
  finally { console.log(JSON.stringify({event: 'devbox.lifecycle.' + event + '.exit', step, id, at: Date.now(), ms: Date.now() - at})); }
}
`;

const methods = new Set(['activate', 'durableClaim', 'adoptOrTurnOver', 'runStartHook', 'restoreInStartGate', 'readBootId', 'rawExec', 'exec', 'ensureReady', 'resolveReadiness', 'startContainerForRPC',
  'startContainer', 'recoverAndStart', 'admitControlListener', 'startAndWaitForPorts', 'startContainerIfNotRunning', 'waitForPort', 'syncPendingStoppedEvents']);

for (const path of files) {
  const absolute = root + path;

  if (!realpathSync(absolute).startsWith(root)) throw new Error(`refusing a shared dependency: ${path}; copy it into this worktree first`);
  const source = readFileSync(absolute, 'utf8');

  if (source.includes('function devboxLifecycleTrace')) throw new Error(`already instrumented: ${path}`);
  const parsed = parse(path, source);
  const edits: { at: number; text: string }[] = [];
  const label = (node: SyntaxNode): string => JSON.stringify(`${path.split('/').at(-1)}:${parsed.lineAt(node.start)}`);

  const visit = (node: SyntaxNode, selected: boolean): void => {
    if (node.type === 'MethodDefinition') selected = methods.has((declaredName(node) ?? '').replace(/^#/, ''));

    if (node.raw.type === 'CallExpression' && memberCalleeName(node) === 'blockConcurrencyWhile') {
      const argument = node.raw.arguments[0];
      const callback = node.children.find(child => child.start === argument?.start);

      if (callback !== undefined) {
        edits.push({ at: callback.start, text: `() => devboxLifecycleTrace('block', ${label(node)}, ` });
        edits.push({ at: callback.end, text: ')' });
        visit(callback, true);
      }

      return;
    }

    if (selected && node.raw.type === 'AwaitExpression') {
      edits.push({ at: node.raw.argument.start, text: `devboxLifecycleTrace('await', ${label(node)}, async () => (` });
      edits.push({ at: node.raw.argument.end, text: '))' });
    }

    for (const child of node.children) visit(child, selected);
  };

  visit(parsed.root, false);
  let output = source;

  for (const edit of edits.sort((a, b) => b.at - a.at)) output = output.slice(0, edit.at) + edit.text + output.slice(edit.at);
  output += path.endsWith('.ts') ? helper.replace('(event, step, run)', '<T>(event: string, step: string, run: () => Promise<T>): Promise<T>') : helper;
  writeFileSync(absolute, output);
}
