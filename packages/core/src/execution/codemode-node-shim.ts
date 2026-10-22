/**
 * The Node-convenience module beside an `eval` program, plain JS for the sandbox isolate: Nimbus's node-compat `fs` and
 * `child_process` over `workspace` (its files, and each machine's exec), `process.cwd()` at the working root,
 * `workspace.slates` objects, a `fetch` that rejects the egress entrypoint's marked 502, and isolated crafted tools.
 */

import { SLATE_PROGRAM_MEMBERS } from '../slates/rpc';

export const KINU_NODE_MODULE_NAME = 'kinu-node.js';

export const KINU_NODE_MODULE_SOURCE = String.raw`
const BUILTINS = [
  'node:path', 'node:url', 'node:util', 'node:crypto', 'node:buffer', 'node:events',
  'node:assert', 'node:stream', 'node:string_decoder', 'node:querystring', 'node:zlib',
  'node:os', 'node:timers', 'node:async_hooks', 'node:stream/web', 'node:stream/promises',
  'node:util/types', 'node:timers/promises',
];

export async function loadBuiltins() {
  const loaded = {};
  const missing = [];
  await Promise.all(BUILTINS.map(async (name) => {
    try {
      loaded[name] = await import(name);
    } catch (cause) {
      missing.push(name + ': ' + (cause && cause.message ? cause.message : String(cause)));
    }
  }));
  return { loaded, missing };
}

/** The error a member refused with, or null for a value. Refusals are objects; text is never read as one. */
function refusalOf(result) {
  return result && typeof result === 'object' && typeof result.error === 'string'
    && (result.success === false || typeof result.reason === 'string') ? result.error : null;
}

/** The platform's process object plus a working directory: the root relative paths resolve against. */
export function createProcess(cwd) {
  const own = { cwd: () => cwd };
  return globalThis.process ? Object.setPrototypeOf(own, globalThis.process) : own;
}

/** The errno a refusal's reason stands for when its text names none. Only a stated absence is ENOENT: a read that was
 *  refused or could not be made says nothing of whether the file is there, so an append never reads it as empty. */
const ERRNO_OF_REASON = { missing: 'ENOENT', denied: 'EACCES', bad_input: 'EINVAL', unsupported: 'ENOTSUP', timeout: 'ETIMEDOUT', cancelled: 'ECANCELED' };

/** A failure as Node's fs reads one from the files it is given: its errno, the syscall and the path, in Node's words. */
function nodeError(code, text, syscall, path) {
  return Object.assign(new Error(code + ': ' + text + ', ' + syscall + " '" + path + "'"), { code, syscall, path });
}

/** A member's value, or its refusal thrown with the errno its text names, else its reason's, else EIO. */
async function answered(call, syscall, path) {
  const result = await call;
  const refused = refusalOf(result);
  if (refused === null) return result;
  const named = /^(E[A-Z]+): /.exec(refused);
  throw nodeError(named ? named[1] : (ERRNO_OF_REASON[result.reason] || 'EIO'), named ? refused.slice(named[0].length) : refused, syscall, path);
}

/** The errno a failed command's own words name (coreutils' strerror text), else EIO. */
const ERRNO_OF_TEXT = [
  ['No such file or directory', 'ENOENT'], ['File exists', 'EEXIST'], ['Not a directory', 'ENOTDIR'], ['Is a directory', 'EISDIR'],
  ['Directory not empty', 'ENOTEMPTY'], ['Permission denied', 'EACCES'], ['Read-only file system', 'EROFS'],
];

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * A command's result as Node reports it, asked for as the command wrote it (parts), on the machine whose files its cwd
 * is (\`fs.machine\`), through that machine's own exec; with no cwd, the workspace's. A refusal ran nothing (126).
 */
async function execParts(machines, command, cwd) {
  const where = cwd === undefined ? null : await machines.workspace.fs.machine(cwd);
  const refusedWhere = where === null ? null : refusalOf(where);
  if (refusedWhere !== null) return { exitCode: 126, stdout: '', stderr: refusedWhere };
  const machine = where === null ? machines.workspace : machines[where.machine];
  if (!machine) return { exitCode: 126, stdout: '', stderr: cwd + ' is on ' + where.machine + ', which this program has no namespace for' };
  const options = where === null ? {} : { cwd: where.path, ...(where.device === undefined ? {} : { device: where.device }) };
  const result = await machine.exec(command, { ...options, parts: true });
  const refused = refusalOf(result);
  if (refused !== null) return { exitCode: 126, stdout: '', stderr: refused };
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** Bytes as base64, chunked so a large file does not overflow String.fromCharCode's arguments. */
function toBase64(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/**
 * The workspace's files as Node's fs asks for them (Nimbus's node-compat \`NodeFiles\`), through the program's file
 * namespace, so its gates and records apply as to any of its calls. What the namespace has no member for (a directory
 * made or removed, a rename, a copy) is the workspace's own command. Links, modes and descriptors are not here: Node's
 * fs answers ENOSYS for them.
 */
function workspaceFiles(workspace) {
  async function stat(path) {
    const found = await answered(workspace.fs.stat(path), 'stat', path);
    const at = found.mtimeMs;
    return {
      dev: 0, ino: 0, nlink: 1, type: found.isDir ? 'directory' : 'file', size: found.size, ctime: at, atime: at, mtime: at,
      mode: found.isDir ? 0o40755 : 0o100644, uid: 0, gid: 0, revision: 0,
    };
  }
  /** The file's bytes exactly, as the file plane reads them (file.text with base64), for a file that is not text too. */
  const readFile = async (path) => fromBase64(await answered(workspace.fs.text(path, { encoding: 'base64' }), 'open', path));
  /** A string is written as its text; bytes as the bytes exactly. */
  async function writeFile(path, data) {
    await answered(typeof data === 'string' ? workspace.fs.write(path, data) : workspace.fs.write(path, toBase64(data), { encoding: 'base64' }), 'open', path);
  }
  /** \`command\`, run for \`syscall\` on \`path\`: its failure as the errno its words name. */
  async function run(command, syscall, path) {
    const outcome = await execParts({ workspace }, command, undefined);
    if (outcome.exitCode === 0) return;
    const text = outcome.stderr.trim() || outcome.stdout.trim() || ('exit ' + outcome.exitCode);
    const named = ERRNO_OF_TEXT.find(([words]) => text.includes(words));
    throw nodeError(named ? named[1] : 'EIO', text, syscall, path);
  }
  return {
    stat, lstat: stat, readFile, writeFile,
    readFileString: async (path) => await answered(workspace.fs.text(path), 'open', path),
    // Absent only where the plane says so: a stat refused otherwise says nothing of the file, so access fails with its errno.
    async exists(path) {
      const [found] = await Promise.allSettled([stat(path)]);
      if (found.status === 'fulfilled') return true;
      if (found.reason && found.reason.code === 'ENOENT') return false;
      throw found.reason;
    },
    async readdir(path) {
      const entries = [];
      // A listing comes a page at a time; Node's is the whole directory. The plane names no entry's type: fs asks.
      for (let offset = 0; ;) {
        const page = await answered(workspace.fs.list(path, { offset }), 'scandir', path);
        entries.push(...page.entries.map((name) => ({ name, type: 'unknown' })));
        if (!page.truncated || page.truncated.next >= page.truncated.total || page.entries.length === 0) return entries;
        offset = page.truncated.next;
      }
    },
    // Read, joined, written whole: a file that is not there starts empty, and any other failed read fails the append
    // before anything is written.
    async appendFile(path, data) {
      const [read] = await Promise.allSettled([readFile(path)]);
      if (read.status === 'rejected' && !(read.reason && read.reason.code === 'ENOENT')) throw read.reason;
      const current = read.status === 'fulfilled' ? read.value : new Uint8Array(0);
      const added = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const joined = new Uint8Array(current.length + added.length);
      joined.set(current);
      joined.set(added, current.length);
      await writeFile(path, joined);
    },
    mkdir: (path, options) => run('mkdir ' + (options && options.recursive ? '-p ' : '') + '-- ' + shellQuote(path), 'mkdir', path),
    unlink: (path) => run('rm -- ' + shellQuote(path), 'unlink', path),
    rmdir: (path) => run('rmdir -- ' + shellQuote(path), 'rmdir', path),
    rmdirRecursive: (path) => run('rm -r -- ' + shellQuote(path), 'rm', path),
    rename: (from, to) => run('mv -- ' + shellQuote(from) + ' ' + shellQuote(to), 'rename', from),
    copyFile: (from, to) => run('cp -- ' + shellQuote(from) + ' ' + shellQuote(to), 'copyfile', from),
  };
}

/** A shell's own line (\`exec\`, or \`shell: true\`): the exec runs its command in a shell already. */
function shellLine(argv) {
  return argv.length === 3 && (argv[0] === '/bin/sh' || argv[0] === 'sh') && argv[1] === '-c' ? argv[2] : null;
}

/**
 * A program child_process starts (Nimbus's node-compat \`NodeStart\`), on the machine whose files its cwd is, through
 * that machine's own exec, its argv quoted as one command. That exec answers at the command's exit, so its output
 * comes then; it is given no stdin, it runs with the machine's own environment, not \`env\`, and a kill does not reach it.
 */
function machineStart(machines) {
  return async (program, cancel) => {
    if (cancel.aborted) throw Object.assign(new Error('spawn ' + program.argv[0] + ' ECANCELED'), { code: 'ECANCELED' });
    const command = shellLine(program.argv) ?? program.argv.map(shellQuote).join(' ');
    const ran = execParts(machines, command, program.cwd)
      .catch((cause) => ({ exitCode: 126, stdout: '', stderr: cause && cause.message ? cause.message : String(cause) }));
    const encoder = new TextEncoder();
    const output = new ReadableStream({
      async start(controller) {
        const outcome = await ran;
        if (outcome.stdout !== '') controller.enqueue({ stream: 'stdout', data: encoder.encode(outcome.stdout) });
        if (outcome.stderr !== '') controller.enqueue({ stream: 'stderr', data: encoder.encode(outcome.stderr) });
        controller.close();
      },
    });
    return { output, exit: ran.then((outcome) => ({ code: outcome.exitCode, signal: null })), kill: () => {} };
  };
}

/** Node's child_process, whose \`exec\` and \`execFile\` given no callback also resolve, awaited, to { stdout, stderr }
 *  (util.promisify's answer, a failure's error carrying both), as this sandbox's programs have always awaited them. */
function awaitable(childProcess) {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const thenable = (run) => Object.defineProperty((...args) => {
    if (typeof args[args.length - 1] === 'function') return run(...args);
    const promise = run[custom](...args);
    // A child only listened to is not an unhandled failure.
    promise.catch(() => {});
    return Object.assign(promise.child, { then: promise.then.bind(promise), catch: promise.catch.bind(promise), finally: promise.finally.bind(promise) });
  }, custom, { value: run[custom] });
  return { ...childProcess, exec: thenable(childProcess.exec), execFile: thenable(childProcess.execFile) };
}

/**
 * \`machines\`: the program's computer and device namespaces, where it has them, for a command whose cwd is theirs.
 * \`createNodeCompat\`: Nimbus's node-compat (\`@nimbus-sh/core/node-compat\`), Node's fs and child_process written once.
 */
export function createRequire({ workspace, machines, builtins, cwd, createNodeCompat }) {
  const { fs, fsPromises, childProcess } = createNodeCompat({ files: workspaceFiles(workspace), start: machineStart({ ...machines, workspace }) }, { cwd });
  const table = {
    fs, 'fs/promises': fsPromises, child_process: awaitable(childProcess),
  };
  for (const [name, module] of Object.entries(builtins)) {
    table[name.slice('node:'.length)] = module;
  }
  const require = (specifier) => {
    const name = String(specifier).replace(/^node:/, '');
    if (Object.prototype.hasOwnProperty.call(table, name)) return table[name];
    throw new Error("Cannot find module '" + specifier + "': this sandbox has the Node builtins plus fs, fs/promises and child_process over the workspace. There is no package install here; use fetch() for HTTP and the tool namespaces for everything else.");
  };
  require.resolve = (specifier) => String(specifier);
  require.available = Object.keys(table).sort();
  return require;
}

export function createFetch(failureHeader) {
  const platformFetch = globalThis.fetch;
  return async (input, init) => {
    const response = await platformFetch(input, init);
    if (response.headers.get(failureHeader) === '1') {
      throw new TypeError('fetch failed: ' + (await response.text()));
    }
    return response;
  };
}

/**
 * workspace.slates: workspace.slates.<id> is that slate's server class, the stub its own client gets,
 * and $-named members, which no class method can take, are the lifecycle. The host's one slate
 * operation is captured here and shadowed, so a program reaches slates through these members only.
 */
export function bindSlates(workspace) {
  // A member the workspace serves is its own, in both sandboxes; any other name reads as a member that refuses when called.
  if (workspace === null || !('slates' in workspace)) return;
  const operate = workspace.slates;
  if (typeof operate !== 'function') return;
  const members = ${JSON.stringify(SLATE_PROGRAM_MEMBERS)};
  // Never a class method here: 'then' would make a slate look like a promise to await, and the rest
  // are what a conversion to text or JSON reaches for.
  const inert = (name) => typeof name !== 'string' || ['then', 'toJSON', 'toString', 'valueOf'].includes(name);
  const lifecycle = (on, id, name) => {
    const op = name.slice(1);
    if (!Object.hasOwn(members, op) || members[op].on !== on) return undefined;
    return (...args) => {
      const operation = members[op].params[0] === '...' ? { ...args[0], op } : { op };
      members[op].params.forEach((param, i) => { if (param !== '...' && args[i] !== undefined) operation[param] = args[i]; });
      if (id !== null) operation.id = id;
      return operate(operation);
    };
  };
  const slate = (id) => new Proxy({}, {
    get: (_, name) => {
      if (inert(name)) return undefined;
      if (name.startsWith('$')) return lifecycle('slate', id, name);
      return (...args) => operate({ op: 'call', id, method: name, args });
    },
  });
  workspace.slates = new Proxy({}, {
    get: (_, name) => {
      if (inert(name)) return undefined;
      return name.startsWith('$') ? lifecycle('directory', null, name) : slate(name);
    },
  });
}

export function defineCrafted(name, factory, reportFailure) {
  // The factory is async so a stored body may await at its top level, which
  // means it answers a promise: the source is evaluated once, on the first
  // call, and the settled value is what every later call runs. A body that
  // throws while evaluating, or evaluates to something that is not a
  // function, poisons only its own name and says so on each call.
  let loaded;
  const load = async () => {
    let impl;
    try {
      impl = await factory();
    } catch (cause) {
      throw new Error('[crafted:' + name + '] failed to load: ' + (cause && cause.message ? cause.message : String(cause)), { cause });
    }
    if (typeof impl !== 'function') {
      throw new Error('[crafted:' + name + '] is not a function: its stored source evaluates to ' + typeof impl);
    }
    return impl;
  };
  return async (...args) => {
    try {
      loaded ??= load();
      const impl = await loaded;
      return await impl(...args);
    } catch (cause) {
      const marker = '[crafted:' + name + ']';
      const error = cause instanceof Error && cause.message.startsWith(marker)
        ? cause : new Error(marker + ' ' + (cause && cause.message ? cause.message : String(cause)), { cause });
      if (reportFailure === undefined) throw error;
      let code = null;
      let link = cause;
      const seen = new Set();
      while (link && !seen.has(link)) {
        seen.add(link);
        if (typeof link.code === 'string') code ??= link.code;
        link = link.cause;
      }
      return reportFailure({ message: error.message, name: cause && typeof cause.name === 'string' ? cause.name : 'Error', code });
    }
  };
}
`;
