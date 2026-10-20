/**
 * Members and fields taken off the surface, each with what took its place. A call to one is refused naming its
 * successor, so stored code that still calls it says what to change; nothing here runs. The one place retired names live.
 */

/** `namespace.member` → what replaced it, as a program calls it. */
const RETIRED_MEMBERS = {
  'workspace.killProcess': 'workspace.stopProcess(processId)',
  'workspace.runCode': "workspace.exec(command): `node -e '...'`, `python3 -c '...'`, `ruby -e '...'`; for TypeScript, write a .ts file and run `node file.ts`",
  'workspace.installRuntime': 'workspace.exec: a runtime installs the first time a command needs it',
  'workspace.listRuntimes': 'the Execution status in your context, which lists what each machine runs',
  'workspace.readFile': 'workspace.fs.text(path)',
  'workspace.writeFile': 'workspace.fs.write(path, content)',
  'workspace.readdir': 'workspace.fs.list(path)',
  'workspace.exists': 'workspace.fs.stat(path), which refuses a path that is not there',
  'computer.readdir': 'computer.fs.list(path)',
  'computer.exists': 'computer.fs.stat(path), which refuses a path that is not there',
  'computer.deleteFile': "computer.exec('rm -- <path>')",
  'device.readdir': 'device.fs.list(path)',
  'device.exists': 'device.fs.stat(path), which refuses a path that is not there',
  'parent.readdir': 'file.list(path): the folder you share with your parent is among your own files',
  'parent.exists': 'file.stat(path), which refuses a path that is not there',
  'agent.proposeWorkspace': 'agent.createWorkspace(name, brief, soul), which creates it at once and answers its link',
} as const satisfies Readonly<Record<string, string>>;

/** `namespace.operation` → each retired field and what to use instead. */
const RETIRED_FIELDS = {
  'agents.hire': { mission: '"message"' },
  // `hold` is only ever a duration (key's); a click's held modifiers had the same name, and models sent a click 500.
  'computer.click': { hold: '"keys", the modifiers held during the click, as ["shift"] or ["ctrl", "shift"]; a click is not held for a time' },
  'workspace.startProcess': {
    env: 'the variables at the head of the command, as `PORT=4100 node server.js`',
    timeoutMs: 'stopProcess(processId) when the work is done',
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

/** A namespace taken off the surface whole → what to use instead. */
const RETIRED_NAMESPACES = {
  state: "a private db table: db.createTable({ name, scope: 'private', columns }) once, then db.select, and db.batch to replace a row",
} as const satisfies Readonly<Record<string, string>>;

/** What a program naming a retired namespace is told, or null for any other name. */
export function retiredNamespace(name: string): string | null {
  const successor = Object.entries(RETIRED_NAMESPACES).find(([retired]) => retired === name)?.[1];

  return successor === undefined ? null : `${name} was removed: use ${successor}`;
}

/** What a call to a retired member is told, or null for any other name. */
export function retiredMember(namespace: string, member: string): string | null {
  const name = `${namespace}.${member}`;

  const successor = Object.entries(RETIRED_MEMBERS).find(([retired]) => retired === name)?.[1];

  return successor === undefined ? null : `${name} was removed: use ${successor}`;
}

/** The retired members of `ns`, each with what a call to it is told. */
export function retiredMembersOf(ns: string): readonly { readonly member: string; readonly told: string }[] {
  return Object.entries(RETIRED_MEMBERS).flatMap(([name, successor]) => (name.startsWith(`${ns}.`)
    ? [{ member: name.slice(ns.length + 1), told: `${name} was removed: use ${successor}` }]
    : []));
}

/** What a retired field sent to `operation` is told, or null for any other field. */
export function retiredField(operation: string, field: string): string | null {
  const fields = Object.entries(RETIRED_FIELDS).find(([retired]) => retired === operation)?.[1];
  const successor = fields === undefined ? undefined : Object.entries(fields).find(([retired]) => retired === field)?.[1];

  return successor === undefined ? null : `"${field}" was removed: use ${successor}`;
}
