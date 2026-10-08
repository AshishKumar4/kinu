/**
 * The executors' members as programs call them: the workspace (its files, shell, crafted tools and, on Nimbus, its
 * processes, ports and runtimes), the sandbox container, the parent workspace a hire reads, and the user's machine.
 * Each executor is its own namespace on its own plane, so each member is its own operation.
 */
import * as v from 'valibot';
import { CRAFTED_TOOL_BODY, WORKSPACE_FILE_BINDINGS } from '../types/codemode';
import { defineOperation, type Impact, type Operation } from './operation';

const described = <S extends v.GenericSchema>(schema: S, text: string) => v.pipe(schema, v.description(text));

const Path = described(v.pipe(v.string(), v.nonEmpty()), 'Relative paths resolve at the executor\'s home.');

const Command = v.pipe(v.string(), v.nonEmpty());

const Port = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535));

const Text = v.string();

/** An executor's member; Plan keeps only what observes. */
const executorOp = (ns: string) => <const I extends v.StrictObjectSchema<v.ObjectEntries, undefined>, const O extends v.GenericSchema>(
  op: Pick<Operation<I, O>, 'name' | 'help' | 'input' | 'output'> & { readonly impact: Impact },
) => defineOperation({ ns, availability: 'code', slate: true, ...op });

const ws = executorOp('workspace');

export const WORKSPACE = {
  readFile: ws({ name: 'readFile', help: 'A file of the workspace, as text.', impact: 'observe', input: v.strictObject({ path: Path }), output: Text }),
  writeFile: ws({
    name: 'writeFile', impact: 'mutate', input: v.strictObject({ path: Path, content: v.string() }), output: Text,
    help: 'Write a file, creating its parent directories. A new file is written at once; replacing one needs readFile first.',
  }),
  readdir: ws({ name: 'readdir', help: 'A directory\'s entry names.', impact: 'observe', input: v.strictObject({ path: Path }), output: v.array(v.string()) }),
  exists: ws({ name: 'exists', help: 'Whether a path exists.', impact: 'observe', input: v.strictObject({ path: Path }), output: v.boolean() }),
  exec: ws({
    name: 'exec', impact: 'execute', output: Text,
    help: 'Run a command in the workspace shell, over the same files readFile reads: a POSIX shell with ~95 coreutils, pipes, '
      + 'redirects, loops and variables. Each call starts fresh in `cwd` (default your home) unless it names a shell, which '
      + 'keeps its directory and exported variables. Use sandbox or device only when the task needs that machine.',
    input: v.strictObject({
      command: Command,
      cwd: v.optional(described(v.string(), 'Where the command starts.')),
      name: v.optional(described(v.pipe(v.string(), v.nonEmpty()), 'A shell that keeps its directory and variables between calls naming it.')),
    }),
  }),
  listTools: ws({
    name: 'listTools', help: 'Your crafted tools, with each one\'s quality score.', impact: 'observe', input: v.strictObject({}),
    output: v.array(v.object({ name: v.string(), description: v.string(), qualityScore: v.number() })),
  }),
  createTool: ws({
    name: 'createTool', impact: 'mutate',
    help: 'Save a crafted tool, callable as `tools.<name>(args)` from the next program; the same name updates it. `code` is '
      + `${CRAFTED_TOOL_BODY}; helpers may precede it. In its body, ${WORKSPACE_FILE_BINDINGS}, and call `
      + '`tools.<name>(args)`; `require`, `import` and `eval` are refused.',
    input: v.strictObject({ name: v.pipe(v.string(), v.nonEmpty()), description: v.pipe(v.string(), v.nonEmpty()), code: v.pipe(v.string(), v.nonEmpty()) }),
    output: v.object({ name: v.string(), action: v.picklist(['created', 'updated']) }),
  }),
  runCode: ws({
    name: 'runCode', help: 'Run a snippet in a language runtime of the workspace.', impact: 'execute', output: Text,
    input: v.strictObject({
      code: v.pipe(v.string(), v.nonEmpty()),
      language: v.optional(v.picklist(['javascript', 'typescript', 'python', 'ruby', 'shell'])),
      install: v.optional(described(v.picklist(['never', 'ifMissing']), 'Install the runtime when missing; default never.')),
    }),
  }),
  startProcess: ws({
    name: 'startProcess', help: 'Start a background process; answers its pid.', impact: 'administer', output: Text,
    input: v.strictObject({
      command: Command, cwd: v.optional(v.string()),
      timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))), env: v.optional(v.record(v.string(), v.string())),
    }),
  }),
  killProcess: ws({ name: 'killProcess', help: 'Stop a background process.', impact: 'administer', input: v.strictObject({ pid: v.number() }), output: Text }),
  logs: ws({
    name: 'logs', help: 'A background process\'s recent output.', impact: 'observe', output: Text,
    input: v.strictObject({ pid: v.number(), lines: v.optional(v.number()), bytes: v.optional(v.number()) }),
  }),
  exposePort: ws({
    name: 'exposePort', impact: 'administer', input: v.strictObject({ port: Port }), output: Text,
    help: 'A public URL for a port a process serves, then whether it was reached.',
  }),
  unexposePort: ws({ name: 'unexposePort', help: 'Withdraw a port\'s public URL.', impact: 'administer', input: v.strictObject({ port: Port }), output: Text }),
  listPorts: ws({ name: 'listPorts', help: 'The exposed ports and their URLs.', impact: 'observe', input: v.strictObject({}), output: Text }),
  installRuntime: ws({ name: 'installRuntime', help: 'Install a language runtime, by spec.', impact: 'administer', input: v.strictObject({ spec: v.pipe(v.string(), v.nonEmpty()) }), output: Text }),
  listRuntimes: ws({ name: 'listRuntimes', help: 'The installed language runtimes.', impact: 'observe', input: v.strictObject({}), output: Text }),
} as const;

const sb = executorOp('sandbox');

/** The sandbox container's members; `resize` is declared over the host's own size table. */
export const SANDBOX = {
  exec: sb({
    name: 'exec', impact: 'execute', input: v.strictObject({ command: Command }), output: Text,
    help: 'Run a command in the sandbox container. Bun is the default toolchain here (`bun install`, `bun run`, `bun x`, `bun test`). '
      + 'A sandbox restored after it slept keeps its source and lockfiles but not node_modules or build output: after a failed '
      + 'import there, run `bun install` once.',
  }),
  readFile: sb({ name: 'readFile', help: 'A file of the sandbox, as text.', impact: 'observe', input: v.strictObject({ path: Path }), output: Text }),
  writeFile: sb({ name: 'writeFile', help: 'Write a file in the sandbox.', impact: 'mutate', input: v.strictObject({ path: Path, content: v.string() }), output: Text }),
  listFiles: sb({
    name: 'listFiles', help: 'A directory\'s entries; the working directory when no path is given.', impact: 'observe',
    input: v.strictObject({ path: v.optional(v.string()) }), output: Text,
  }),
  readdir: sb({ name: 'readdir', help: 'As listFiles.', impact: 'observe', input: v.strictObject({ path: v.optional(v.string()) }), output: Text }),
  deleteFile: sb({ name: 'deleteFile', help: 'Delete a file in the sandbox.', impact: 'mutate', input: v.strictObject({ path: Path }), output: Text }),
  exists: sb({ name: 'exists', help: '"true" or "false".', impact: 'observe', input: v.strictObject({ path: Path }), output: Text }),
  startProcess: sb({
    name: 'startProcess', help: 'A supervised background process; answers JSON {processId, restartable: true}.', impact: 'administer',
    input: v.strictObject({ command: Command, cwd: v.optional(v.string()) }), output: Text,
  }),
  stopProcess: sb({ name: 'stopProcess', help: 'Stop a supervised process.', impact: 'administer', input: v.strictObject({ processId: v.pipe(v.string(), v.nonEmpty()) }), output: Text }),
  listProcesses: sb({ name: 'listProcesses', help: 'JSON rows {processId, pid, status, restartable, command}.', impact: 'observe', input: v.strictObject({}), output: Text }),
  rest: sb({
    name: 'rest', help: '"now" saves and stops the sandbox, ending what runs; "keep" runs on until it asks again.', impact: 'administer',
    input: v.strictObject({ answer: v.picklist(['now', 'keep']) }), output: Text,
  }),
  exposePort: sb({
    name: 'exposePort', help: 'A public URL for a port the sandbox serves.', impact: 'administer',
    input: v.strictObject({ port: Port, name: v.optional(v.string()) }), output: Text,
  }),
  unexposePort: sb({ name: 'unexposePort', help: 'Withdraw a port\'s public URL.', impact: 'administer', input: v.strictObject({ port: Port }), output: Text }),
  listPorts: sb({ name: 'listPorts', help: 'The exposed ports and their URLs.', impact: 'observe', input: v.strictObject({}), output: Text }),
} as const;

/** `sandbox.resize` over the host's sizes, each described as it runs. */
export function sandboxResize(sizes: readonly { readonly size: string; readonly vcpu: number; readonly memoryMib: number }[]) {
  const choices = sizes.map((row) => `${row.size}: ${String(row.vcpu)} vCPU, ${String(Math.round(row.memoryMib / 102.4) / 10)} GiB`).join('; ');

  return sb({
    name: 'resize', impact: 'administer', output: Text,
    help: `${choices}. A running sandbox restarts at the new size: files stay, supervised servers and ports come back, a running command ends.`,
    input: v.strictObject({ size: v.picklist(sizes.map((row) => row.size)) }),
  });
}

const parent = executorOp('parent');

/** The parent workspace a hire reads, in the parent's own paths. */
export const PARENT = {
  readFile: parent({ name: 'readFile', help: 'A file of the parent workspace.', impact: 'observe', input: v.strictObject({ path: Path }), output: Text }),
  writeFile: parent({ name: 'writeFile', help: 'Write a file in the parent workspace.', impact: 'mutate', input: v.strictObject({ path: Path, content: v.string() }), output: Text }),
  readdir: parent({ name: 'readdir', help: 'A directory\'s entry names.', impact: 'observe', input: v.strictObject({ path: Path }), output: v.array(v.string()) }),
  exists: parent({ name: 'exists', help: 'Whether a path exists.', impact: 'observe', input: v.strictObject({ path: Path }), output: v.boolean() }),
  exec: parent({
    name: 'exec', impact: 'execute', input: v.strictObject({ command: Command }), output: Text,
    help: 'Run a command in the parent workspace\'s shell, the same coreutils its own agent has: the fast way to search it '
      + '(`grep -rn TODO .`, `find . -name \'*.ts\'`).',
  }),
} as const;

const device = executorOp('device');

const Device = v.optional(described(v.string(), 'With several machines connected, which one, by name.'));

/** The user's own machine; `unavailable` means none is attached, and the error says how to attach one. */
export const DEVICE = {
  exec: device({ name: 'exec', help: 'Run a command on the machine.', impact: 'execute', input: v.strictObject({ command: Command, device: Device }), output: Text }),
  readFile: device({ name: 'readFile', help: 'A file on the machine.', impact: 'observe', input: v.strictObject({ path: Path, device: Device }), output: Text }),
  writeFile: device({ name: 'writeFile', help: 'Write a file on the machine.', impact: 'mutate', input: v.strictObject({ path: Path, content: v.string(), device: Device }), output: Text }),
  readdir: device({ name: 'readdir', help: 'A directory\'s entry names.', impact: 'observe', input: v.strictObject({ path: Path, device: Device }), output: v.array(v.string()) }),
  exists: device({ name: 'exists', help: 'Whether a path exists.', impact: 'observe', input: v.strictObject({ path: Path, device: Device }), output: v.boolean() }),
} as const;
